import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isFixupishSubject, planAutosquash, squashMessages } from '../lib/autosquash';
import { autosquashCommits, getCommitMessage, type CommitInfo } from '../lib/git';

function runGit(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  }).trim();
}

function commitInfo(sha: string, message: string): CommitInfo {
  return { sha, shortSha: sha.slice(0, 7), message, body: '', author: 'a', date: '' };
}

// A plan as [target subject, ...'kind:step subject'] per group, which reads
// far better in an assertion than the nested objects do.
function describePlan(
  commits: CommitInfo[],
  resolve: (name: string) => string | null = () => null,
) {
  return planAutosquash(commits, resolve).map((g) => [
    g.target.message,
    ...g.steps.map((s) => `${s.kind}:${s.commit.message}`),
  ]);
}

describe('isFixupishSubject', () => {
  test('recognises each marker, only with its trailing space', () => {
    expect(isFixupishSubject('fixup! add a')).toBe(true);
    expect(isFixupishSubject('amend! add a')).toBe(true);
    expect(isFixupishSubject('squash! add a')).toBe(true);
    expect(isFixupishSubject('fixup!add a')).toBe(false);
    expect(isFixupishSubject('add a fixup! b')).toBe(false);
  });
});

describe('planAutosquash', () => {
  test('folds each marker into its target, keeping later targets in place', () => {
    const commits = [
      commitInfo('a1', 'add a'),
      commitInfo('b1', 'add b'),
      commitInfo('f1', 'fixup! add a'),
      commitInfo('f2', 'squash! add b'),
      commitInfo('f3', 'amend! add a'),
    ];
    expect(describePlan(commits)).toEqual([
      ['add a', 'fixup:fixup! add a', 'amend:amend! add a'],
      ['add b', 'squash:squash! add b'],
    ]);
  });

  test('strips stacked markers, taking the kind from the outermost one', () => {
    const commits = [
      commitInfo('a1', 'add a'),
      commitInfo('f1', 'fixup! add a'),
      commitInfo('f2', 'squash! fixup! add a'),
    ];
    expect(describePlan(commits)).toEqual([
      ['add a', 'fixup:fixup! add a', 'squash:squash! fixup! add a'],
    ]);
  });

  test('matches an exact subject before a prefix, and a prefix as a last resort', () => {
    const commits = [
      commitInfo('a1', 'add a thing'),
      commitInfo('a2', 'add a'),
      commitInfo('f1', 'fixup! add a'),
      commitInfo('f2', 'fixup! add a th'),
    ];
    expect(describePlan(commits)).toEqual([
      ['add a thing', 'fixup:fixup! add a th'],
      ['add a', 'fixup:fixup! add a'],
    ]);
  });

  test('matches a commit named by sha, but only an earlier one', () => {
    const commits = [
      commitInfo('aaaa111', 'add a'),
      commitInfo('f1', 'fixup! aaaa'),
      commitInfo('f2', 'fixup! cccc'),
      commitInfo('cccc333', 'add c'),
    ];
    const resolve = (name: string) =>
      ({ aaaa: 'aaaa111', cccc: 'cccc333' })[name as 'aaaa' | 'cccc'] ?? null;
    expect(describePlan(commits, resolve)).toEqual([
      ['add a', 'fixup:fixup! aaaa'],
      ['fixup! cccc'],
      ['add c'],
    ]);
  });

  test('flags a marker that matched nothing, and leaves it where it is', () => {
    const groups = planAutosquash(
      [commitInfo('a1', 'add a'), commitInfo('f1', 'fixup! add z')],
      () => null,
    );
    expect(groups.map((g) => [g.target.message, g.unmatchedMarker])).toEqual([
      ['add a', false],
      ['fixup! add z', true],
    ]);
  });
});

describe('squashMessages', () => {
  test('a fixup keeps the message', () => {
    expect(squashMessages('add a\n\nbody', [{ kind: 'fixup', message: 'fixup! add a' }])).toEqual({
      message: 'add a\n\nbody',
      needsEdit: false,
      sources: [true, false],
    });
  });

  test("an amend replaces it with the amend commit's body", () => {
    expect(
      squashMessages('add a', [{ kind: 'amend', message: 'amend! add a\n\nadd a, better\n\nwhy' }]),
    ).toEqual({ message: 'add a, better\n\nwhy', needsEdit: false, sources: [false, true] });
  });

  test('a squash appends its body and needs an edit; an amend after it appends too', () => {
    expect(
      squashMessages('add a', [
        { kind: 'squash', message: 'squash! add a\n\nmore about a' },
        { kind: 'amend', message: 'amend! add a\n\neven more' },
      ]),
    ).toEqual({
      message: 'add a\n\nmore about a\n\neven more',
      needsEdit: true,
      sources: [true, true, true],
    });
  });

  test('an amend! with no body keeps the message, and counts for nothing', () => {
    expect(
      squashMessages('add a', [
        { kind: 'amend', message: 'amend! add a' },
        { kind: 'amend', message: 'amend! add a\n\nfinal' },
        { kind: 'fixup', message: 'fixup! add a' },
      ]),
    ).toEqual({ message: 'final', needsEdit: false, sources: [false, false, true, false] });
  });
});

describe('autosquashCommits', () => {
  let repoDir: string;
  let base: string;
  let tick = 0;

  // Distinct dates, so identical content can never collide on a sha.
  function commit(file: string, content: string, message: string): string {
    fs.writeFileSync(path.join(repoDir, file), content);
    runGit(repoDir, ['add', file]);
    const date = `2024-01-01T00:00:${String(tick++).padStart(2, '0')}`;
    runGit(repoDir, ['commit', '-q', '-m', message], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    return runGit(repoDir, ['rev-parse', 'HEAD']);
  }

  // What the real thing produces, from a scratch branch: tree and message of
  // each commit, oldest-first. GIT_EDITOR=: saves a squash's message as git
  // prepared it, which is what the preview claims to show.
  function realAutosquash(head: string): { tree: string; message: string }[] {
    runGit(repoDir, ['checkout', '-q', '-B', 'real-rebase', head]);
    runGit(repoDir, ['rebase', '-q', '-i', '--autosquash', '--keep-base', 'main'], {
      GIT_SEQUENCE_EDITOR: ':',
      GIT_EDITOR: ':',
    });
    return runGit(repoDir, ['rev-list', '--reverse', 'main..real-rebase'])
      .split('\n')
      .map((sha) => ({
        tree: runGit(repoDir, ['rev-parse', `${sha}^{tree}`]),
        message: getCommitMessage(repoDir, sha)!,
      }));
  }

  function previewed(head: string) {
    const result = autosquashCommits(repoDir, base, head);
    return result.commits.map((c) => ({
      tree: runGit(repoDir, ['rev-parse', `${c.sha}^{tree}`]),
      message: getCommitMessage(repoDir, c.sha)!,
    }));
  }

  beforeEach(() => {
    tick = 0;
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-autosquash-test-'));
    runGit(repoDir, ['init', '-q', '-b', 'main']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);
    runGit(repoDir, ['config', 'commit.gpgSign', 'false']);
    base = commit('base.txt', 'base\n', 'base commit');
    runGit(repoDir, ['checkout', '-q', '-b', 'feature']);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('matches a real rebase -i --autosquash, commit for commit', () => {
    const addA = commit('a.txt', 'a1\n', 'add a\n\nabout a');
    commit('b.txt', 'b1\n', 'add b');
    commit('c.txt', 'c1\n', 'add c');
    commit('a.txt', 'a2\n', 'fixup! add a');
    commit('b.txt', 'b2\n', 'squash! add b\n\nmore about b');
    commit('c.txt', 'c2\n', 'amend! add c\n\nadd c, reworded\n\nwith a body');
    commit('a.txt', 'a3\n', `fixup! ${addA.slice(0, 8)}`);
    const head = commit('d.txt', 'd1\n', 'fixup! fixup! add a');

    const expected = realAutosquash(head);
    expect(expected).toHaveLength(3);
    expect(previewed(head)).toEqual(expected);
  });

  test('matches a real rebase on the message edge cases too', () => {
    commit('a.txt', 'a1\n', 'add a\n\nabout a');
    commit('b.txt', 'b1\n', 'add b');
    commit('a.txt', 'a2\n', 'squash! add a\n\nsquashed in');
    commit('a.txt', 'a3\n', 'amend! add a\n\nadd a, after a squash');
    commit('b.txt', 'b2\n', 'squash! fixup! add b\n\nstacked');
    const head = commit('z.txt', 'z1\n', 'fixup! nothing matches this');

    const expected = realAutosquash(head);
    expect(expected).toHaveLength(3);
    expect(previewed(head)).toEqual(expected);
  });

  test('reuses commits up to the first one that changes, and describes each fold', () => {
    const addA = commit('a.txt', 'a1\n', 'add a');
    const addB = commit('b.txt', 'b1\n', 'add b');
    commit('c.txt', 'c1\n', 'add c');
    const fixup = commit('b.txt', 'b2\n', 'fixup! add b');

    const result = autosquashCommits(repoDir, base, fixup);
    expect(result.conflict).toBeNull();
    expect(result.matchesHead).toBe(true);
    expect(result.sourceShas).toHaveLength(4);
    expect(result.commits.map((c) => [c.message, c.rewritten, c.absorbed.length])).toEqual([
      ['add a', false, 0],
      ['add b', true, 1],
      ['add c', true, 0],
    ]);
    expect(result.commits[0].sha).toBe(addA);
    expect(result.commits[1].originalSha).toBe(addB);
    expect(result.commits[1].absorbed[0]).toMatchObject({ sha: fixup, kind: 'fixup' });
  });

  test('builds the same shas every time', () => {
    commit('a.txt', 'a1\n', 'add a');
    const head = commit('a.txt', 'a2\n', 'fixup! add a');
    expect(autosquashCommits(repoDir, base, head).commits[0].sha).toBe(
      autosquashCommits(repoDir, base, head).commits[0].sha,
    );
  });

  test("leaves the repo's refs, index and working tree alone", () => {
    commit('a.txt', 'a1\n', 'add a');
    const head = commit('a.txt', 'a2\n', 'fixup! add a');
    const refsBefore = runGit(repoDir, ['for-each-ref']);

    autosquashCommits(repoDir, base, head);

    expect(runGit(repoDir, ['for-each-ref'])).toBe(refsBefore);
    expect(runGit(repoDir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(runGit(repoDir, ['status', '--porcelain'])).toBe('');
  });

  test('stops at a fixup that no longer applies once moved up', () => {
    const addA = commit('a.txt', 'one\n', 'add a');
    commit('a.txt', 'two\n', 'change a');
    const fixup = commit('a.txt', 'three\n', 'fixup! add a');

    const result = autosquashCommits(repoDir, base, fixup);
    expect(result.commits).toEqual([]);
    expect(result.matchesHead).toBe(false);
    expect(result.conflict).toEqual({
      sha: fixup,
      shortSha: expect.any(String),
      message: 'fixup! add a',
      targetSha: addA,
      files: ['a.txt'],
    });
  });

  test('refuses a branch containing a merge commit', () => {
    commit('a.txt', 'a1\n', 'add a');
    runGit(repoDir, ['checkout', '-q', '-b', 'side', base]);
    commit('s.txt', 's1\n', 'side');
    runGit(repoDir, ['checkout', '-q', 'feature']);
    runGit(repoDir, ['merge', '-q', '--no-edit', 'side']);
    const head = runGit(repoDir, ['rev-parse', 'HEAD']);

    expect(() => autosquashCommits(repoDir, base, head)).toThrow(/merge commits/);
  });
});
