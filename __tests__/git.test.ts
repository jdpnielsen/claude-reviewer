import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveRepoPath,
  listCommits,
  getCommitDiff,
  getRefDiff,
  resolveRefSha,
  blameCommit,
  getGitUserIdentity,
  getFileAtCommit,
  computeCommitCorrespondence,
} from '../lib/git';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

// Explicit author/committer dates so two commits with identical tree +
// message + parent still get distinct SHAs (git hashes the dates too) -
// needed to simulate "the same logical commit, replayed by a rebase" without
// relying on wall-clock granularity, which real rebases bump anyway.
function commitWithDate(cwd: string, message: string, date: string): string {
  execFileSync('git', ['commit', '-m', message], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

describe('resolveRepoPath', () => {
  const originalPrefix = process.env.HOST_PATH_PREFIX;

  afterEach(() => {
    if (originalPrefix === undefined) {
      delete process.env.HOST_PATH_PREFIX;
    } else {
      process.env.HOST_PATH_PREFIX = originalPrefix;
    }
  });

  test('returns the path unchanged when HOST_PATH_PREFIX is not set', () => {
    delete process.env.HOST_PATH_PREFIX;
    expect(resolveRepoPath('/Users/alice/project')).toBe('/Users/alice/project');
  });

  test('translates a /Users/<user>/... path when HOST_PATH_PREFIX is set', () => {
    process.env.HOST_PATH_PREFIX = '/host-home';
    expect(resolveRepoPath('/Users/alice/project')).toBe('/host-home/project');
  });
});

describe('listCommits', () => {
  let repoDir: string;
  let baseSha: string;
  let headSha: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-git-test-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base commit']);
    baseSha = runGit(repoDir, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a\n');
    runGit(repoDir, ['add', 'a.txt']);
    runGit(repoDir, ['commit', '-m', 'add a\n\nThis is the body.\nSecond body line.']);

    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    runGit(repoDir, ['commit', '-m', 'add b']);
    headSha = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('returns commits between base and head, oldest first', () => {
    const commits = listCommits(repoDir, baseSha, headSha);

    expect(commits).toHaveLength(2);
    expect(commits[0].message).toBe('add a');
    expect(commits[1].message).toBe('add b');
    expect(commits[0].shortSha).toHaveLength(7);
    expect(commits[1].sha).toBe(headSha);
  });

  test('captures a multi-line body separately from the subject, without leaking into other commits', () => {
    const commits = listCommits(repoDir, baseSha, headSha);

    expect(commits[0].body.trim()).toBe('This is the body.\nSecond body line.');
    expect(commits[1].body.trim()).toBe('');
    // A regression here would mean the record separator failed to isolate
    // this commit's multi-line body, bleeding into the next commit's fields.
    expect(commits[1].message).toBe('add b');
    expect(commits[1].author).toBe('Test User');
  });
});

describe('getCommitDiff', () => {
  let repoDir: string;
  let addBSha: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-git-test-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base commit']);

    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a\n');
    runGit(repoDir, ['add', 'a.txt']);
    runGit(repoDir, ['commit', '-m', 'add a']);

    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    runGit(repoDir, ['commit', '-m', 'add b']);
    addBSha = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('returns only the diff introduced by that single commit', () => {
    const diff = getCommitDiff(repoDir, addBSha);

    expect(diff).toContain('b.txt');
    expect(diff).not.toContain('a.txt');
  });
});

describe('getRefDiff', () => {
  let repoDir: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-git-test-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    // main: base commit, then a commit that only main has.
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base commit']);
    runGit(repoDir, ['branch', '-M', 'main']);

    // feature diverges from base and adds its own file.
    runGit(repoDir, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'feature work\n');
    runGit(repoDir, ['add', 'feature.txt']);
    runGit(repoDir, ['commit', '-m', 'add feature']);

    // A commit landing on main *after* feature diverged. With three-dot
    // semantics this must NOT appear in the base...feature diff.
    runGit(repoDir, ['checkout', 'main']);
    fs.writeFileSync(path.join(repoDir, 'main-only.txt'), 'main only\n');
    runGit(repoDir, ['add', 'main-only.txt']);
    runGit(repoDir, ['commit', '-m', 'main moves on']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('returns only changes on the head branch since it diverged from base', () => {
    const diff = getRefDiff(repoDir, 'main', 'feature');

    // feature's own work is present...
    expect(diff).toContain('feature.txt');
    expect(diff).toContain('feature work');
    // ...but commits made on base/main after the fork point are not (this is
    // the three-dot `main...feature` behavior, not a two-dot `main..feature`).
    expect(diff).not.toContain('main-only.txt');
  });

  test('resolves both branch names and raw SHAs as refs', () => {
    const baseSha = runGit(repoDir, ['rev-parse', 'main~1']);
    const headSha = runGit(repoDir, ['rev-parse', 'feature']);
    const diff = getRefDiff(repoDir, baseSha, headSha);
    expect(diff).toContain('feature.txt');
  });

  test('returns an empty string when the head ref has no changes over base', () => {
    const diff = getRefDiff(repoDir, 'feature', 'feature');
    expect(diff).toBe('');
  });
});

describe('resolveRefSha', () => {
  let repoDir: string;
  let headSha: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-git-test-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base commit']);
    runGit(repoDir, ['branch', '-M', 'main']);
    headSha = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('resolves a branch name to its full 40-char commit SHA', () => {
    const sha = resolveRefSha(repoDir, 'main');
    expect(sha).toBe(headSha);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('peels an annotated tag to the commit it points at (^{commit})', () => {
    runGit(repoDir, ['tag', '-a', 'v1', '-m', 'release one']);
    // The tag object's own SHA differs from the commit SHA; `^{commit}` must
    // dereference through it to the underlying commit.
    const tagObjectSha = runGit(repoDir, ['rev-parse', 'v1']);
    const resolved = resolveRefSha(repoDir, 'v1');
    expect(resolved).toBe(headSha);
    expect(resolved).not.toBe(tagObjectSha);
  });
});

describe('blameCommit', () => {
  let repoDir: string;
  let addASha: string;
  let headSha: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-git-test-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base commit']);

    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line one\nline two\n');
    runGit(repoDir, ['add', 'a.txt']);
    runGit(repoDir, ['commit', '-m', 'add a']);
    addASha = runGit(repoDir, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    runGit(repoDir, ['commit', '-m', 'add b']);
    headSha = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('finds the commit that last touched a line', () => {
    const sha = blameCommit(repoDir, headSha, 'a.txt', 1);
    expect(sha).toBe(addASha);
  });

  test("returns null for a file that doesn't exist", () => {
    const sha = blameCommit(repoDir, headSha, 'nope.txt', 1);
    expect(sha).toBeNull();
  });
});

describe('getGitUserIdentity', () => {
  const originalHome = process.env.HOME;
  let tmpHome: string;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tmpHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('reads name and email from a global .gitconfig', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-gitconfig-test-'));
    fs.writeFileSync(
      path.join(tmpHome, '.gitconfig'),
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    );
    process.env.HOME = tmpHome;

    const identity = getGitUserIdentity();
    expect(identity.name).toBe('Test User');
    expect(identity.email).toBe('test@example.com');
  });

  test('returns nulls when no global git config exists', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-gitconfig-test-'));
    process.env.HOME = tmpHome;

    const identity = getGitUserIdentity();
    expect(identity.name).toBeNull();
    expect(identity.email).toBeNull();
  });
});

describe('getFileAtCommit', () => {
  let repoDir: string;
  let sha: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-getfile-test-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line one\nline two\n');
    runGit(repoDir, ['add', 'a.txt']);
    runGit(repoDir, ['commit', '-m', 'add a']);
    sha = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('reads a file as of a specific commit', () => {
    expect(getFileAtCommit(repoDir, sha, 'a.txt')).toBe('line one\nline two\n');
  });

  test('returns null for a file that does not exist at that commit', () => {
    expect(getFileAtCommit(repoDir, sha, 'nope.txt')).toBeNull();
  });

  test('returns null for a commit that does not exist', () => {
    expect(getFileAtCommit(repoDir, '0'.repeat(40), 'a.txt')).toBeNull();
  });
});

describe('computeCommitCorrespondence', () => {
  let repoDir: string;
  let base: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-correspondence-test-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    base = commitWithDate(repoDir, 'base commit', '2024-01-01T00:00:00');
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('matches a pure rebase (identical content, different SHAs) by patch-id', () => {
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a\n');
    runGit(repoDir, ['add', 'a.txt']);
    const oldA = commitWithDate(repoDir, 'add a', '2024-01-02T00:00:00');

    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    const oldB = commitWithDate(repoDir, 'add b', '2024-01-03T00:00:00');

    // Simulate a rebase: replay the same diffs/messages on top of the same
    // base, at a later date - same patch-id, different SHA.
    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a\n');
    runGit(repoDir, ['add', 'a.txt']);
    const newA = commitWithDate(repoDir, 'add a', '2024-02-01T00:00:00');

    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    const newB = commitWithDate(repoDir, 'add b', '2024-02-02T00:00:00');

    expect(newA).not.toBe(oldA);
    expect(newB).not.toBe(oldB);

    const result = computeCommitCorrespondence(repoDir, base, oldB, base, newB);
    expect(Object.fromEntries(result.matched)).toEqual({ [oldA]: newA, [oldB]: newB });
    expect(result.unmatched).toEqual([]);
  });

  test('falls back to matching by commit message when content changed (amend)', () => {
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a\n');
    runGit(repoDir, ['add', 'a.txt']);
    const oldA = commitWithDate(repoDir, 'add a', '2024-01-02T00:00:00');

    // Same message, different content - patch-id can't match this, only the
    // message fallback can.
    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a, amended\n');
    runGit(repoDir, ['add', 'a.txt']);
    const newA = commitWithDate(repoDir, 'add a', '2024-02-01T00:00:00');

    const result = computeCommitCorrespondence(repoDir, base, oldA, base, newA);
    expect(Object.fromEntries(result.matched)).toEqual({ [oldA]: newA });
    expect(result.unmatched).toEqual([]);
  });

  test('leaves a dropped commit unmatched', () => {
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a\n');
    runGit(repoDir, ['add', 'a.txt']);
    const oldA = commitWithDate(repoDir, 'add a', '2024-01-02T00:00:00');

    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    const oldB = commitWithDate(repoDir, 'add b', '2024-01-03T00:00:00');

    // Rebase that drops "add b" entirely (e.g. `rebase -i` with `drop`).
    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a\n');
    runGit(repoDir, ['add', 'a.txt']);
    const newA = commitWithDate(repoDir, 'add a', '2024-02-01T00:00:00');

    const result = computeCommitCorrespondence(repoDir, base, oldB, base, newA);
    expect(Object.fromEntries(result.matched)).toEqual({ [oldA]: newA });
    expect(result.unmatched).toEqual([oldB]);
  });

  test('leaves everything unmatched after an unrelated force-push', () => {
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a\n');
    runGit(repoDir, ['add', 'a.txt']);
    const oldA = commitWithDate(repoDir, 'add a', '2024-01-02T00:00:00');

    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    const oldB = commitWithDate(repoDir, 'add b', '2024-01-03T00:00:00');

    // A completely unrelated new history on top of the same base.
    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(path.join(repoDir, 'unrelated.txt'), 'unrelated content\n');
    runGit(repoDir, ['add', 'unrelated.txt']);
    const newCommit = commitWithDate(repoDir, 'unrelated change', '2024-03-01T00:00:00');

    const result = computeCommitCorrespondence(repoDir, base, oldB, base, newCommit);
    expect(result.matched.size).toBe(0);
    expect(result.unmatched.sort()).toEqual([oldA, oldB].sort());
  });

  test('returns nothing to do when the old range has no commits', () => {
    const result = computeCommitCorrespondence(repoDir, base, base, base, base);
    expect(result.matched.size).toBe(0);
    expect(result.unmatched).toEqual([]);
  });
});
