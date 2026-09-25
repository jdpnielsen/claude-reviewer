/**
 * Comments and reviewed marks made on autosquash preview commits: carried to
 * the next preview as the branch gains fixups, and onto the real commits once
 * the author autosquashes - both lazily, when GET /api/prs/[id] reads the PR.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set up test database path before importing database module - see the
// same pattern in __tests__/database.test.ts.
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-preview-reloc-test-'));
process.env.DATABASE_DIR = testDbDir;
process.env.DATABASE_PATH = path.join(testDbDir, 'test.db');

import { GET as prGetRoute } from '../app/api/prs/[id]/route';
import { reconcilePreviewComments } from '../lib/comment-relocation';
import {
  addComment,
  closeDatabase,
  createPR,
  getComments,
  getReviewedCommitMessages,
  getReviewedFiles,
  lookupCommitRelocation,
  setReviewedCommitMessage,
  setReviewedFile,
  updatePRDiff,
} from '../lib/database';
import { CommentRelocationStatus, CommentTargetType, LineType } from '../lib/enum';
import { autosquashCommits, getBlobHash, getCommitMessageHash } from '../lib/git';

function runGit(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  }).trim();
}

describe('comments on autosquash preview commits', () => {
  let repoDir: string;
  let base: string;

  function commitFile(file: string, content: string, message: string): string {
    fs.writeFileSync(path.join(repoDir, file), content);
    runGit(repoDir, ['add', file]);
    runGit(repoDir, ['commit', '-q', '-m', message]);
    return runGit(repoDir, ['rev-parse', 'HEAD']);
  }

  async function getPR(uuid: string) {
    const res = await prGetRoute(new Request(`http://test/api/prs/${uuid}`) as never, {
      params: Promise.resolve({ id: uuid }),
    });
    return res.json();
  }

  // A comment on line `two` of a.txt, a file mark and a message mark - all
  // on `sha`, the preview's squashed "add a".
  function annotate(uuid: string, sha: string, line: number): string {
    const commentUuid = addComment(
      uuid,
      'a.txt',
      line,
      'about two',
      LineType.New,
      line,
      sha,
      CommentTargetType.Line,
      { content: 'two', contextBefore: 'one', contextAfter: 'three' },
    );
    setReviewedFile(uuid, 'a.txt', sha, getBlobHash(repoDir, sha, 'a.txt')!);
    setReviewedCommitMessage(uuid, sha, getCommitMessageHash(repoDir, sha)!);
    return commentUuid;
  }

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-preview-reloc-repo-'));
    runGit(repoDir, ['init', '-q', '-b', 'main']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);
    runGit(repoDir, ['config', 'commit.gpgSign', 'false']);
    base = commitFile('base.txt', 'base\n', 'base commit');
    runGit(repoDir, ['checkout', '-q', '-b', 'feature']);
    commitFile('a.txt', 'one\ntwo\nthree\n', 'add a');
    commitFile('b.txt', 'b\n', 'add b');
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(testDbDir, { recursive: true, force: true });
  });

  test('follow the squashed commit through another fixup, then onto the real autosquash', async () => {
    const head1 = commitFile('a.txt', 'zero\none\ntwo\nthree\n', 'fixup! add a');
    const uuid = createPR(repoDir, 'preview comments', 'main', 'feature', base, head1, 'diff');
    const s1 = autosquashCommits(repoDir, base, head1).commits[0].sha;
    const commentUuid = annotate(uuid, s1, 3);

    // Nothing to move yet - everything is keyed to the current preview.
    const first = await getPR(uuid);
    expect(first.previewCommits.map((c: { sha: string }) => c.sha)).toContain(s1);
    expect(getComments(uuid)[0].commit_sha).toBe(s1);

    // Another fixup to the same commit: S1 is superseded by S2, whose a.txt
    // has one more line above the comment's.
    const head2 = commitFile('a.txt', 'minus\nzero\none\ntwo\nthree\n', 'fixup! add a');
    updatePRDiff(uuid, 'diff', head2, base);
    const s2 = autosquashCommits(repoDir, base, head2).commits[0].sha;
    expect(s2).not.toBe(s1);

    const second = await getPR(uuid);
    const moved = getComments(uuid).find((c) => c.uuid === commentUuid)!;
    expect(moved).toMatchObject({
      commit_sha: s2,
      line_number: 4,
      status: CommentRelocationStatus.Active,
    });
    expect(getReviewedFiles(uuid).map((r) => r.commit_sha)).toEqual([s2]);
    expect(getReviewedCommitMessages(uuid).map((r) => r.commit_sha)).toEqual([s2]);
    expect(lookupCommitRelocation(uuid, s1)).toBe(s2);
    expect(second.previewCommits.map((c: { sha: string }) => c.sha)).toContain(s2);

    // The author autosquashes for real, and the PR syncs to the result.
    runGit(repoDir, ['rebase', '-q', '-i', '--autosquash', '--keep-base', 'main'], {
      GIT_SEQUENCE_EDITOR: ':',
      GIT_EDITOR: ':',
    });
    const head3 = runGit(repoDir, ['rev-parse', 'HEAD']);
    const realAddA = runGit(repoDir, ['rev-parse', 'HEAD^']);
    updatePRDiff(uuid, 'diff', head3, base);

    const third = await getPR(uuid);
    expect(getComments(uuid).find((c) => c.uuid === commentUuid)).toMatchObject({
      commit_sha: realAddA,
      line_number: 4,
      status: CommentRelocationStatus.Active,
    });
    expect(getReviewedFiles(uuid).map((r) => r.commit_sha)).toEqual([realAddA]);
    expect(getReviewedCommitMessages(uuid).map((r) => r.commit_sha)).toEqual([realAddA]);
    expect(third.previewCommits).toEqual([]);
  });

  test('nothing moves while the preview stops at a conflict', () => {
    const head1 = commitFile('a.txt', 'zero\none\ntwo\nthree\n', 'fixup! add a');
    const uuid = createPR(repoDir, 'conflict', 'main', 'feature', base, head1, 'diff');
    const s1 = autosquashCommits(repoDir, base, head1).commits[0].sha;
    annotate(uuid, s1, 3);

    reconcilePreviewComments(uuid, repoDir, base, head1, [s1], {
      error: null,
      commits: [],
      conflict: { sha: head1, shortSha: head1.slice(0, 7), message: 'm', targetSha: s1, files: [] },
      matchesHead: false,
      sourceShas: [],
    });
    reconcilePreviewComments(uuid, repoDir, base, head1, [s1], { error: 'merge commits' });

    expect(getComments(uuid)[0]).toMatchObject({
      commit_sha: s1,
      status: CommentRelocationStatus.Active,
    });
    expect(getReviewedFiles(uuid).map((r) => r.commit_sha)).toEqual([s1]);
  });

  test('a comment on a commit that no longer exists at all is orphaned', async () => {
    const head1 = commitFile('a.txt', 'zero\none\ntwo\nthree\n', 'fixup! add a');
    const uuid = createPR(repoDir, 'gone', 'main', 'feature', base, head1, 'diff');
    const gone = 'f'.repeat(40);
    addComment(
      uuid,
      '',
      0,
      'on a pruned commit',
      LineType.New,
      0,
      gone,
      CommentTargetType.CommitMessage,
    );

    await getPR(uuid);
    expect(getComments(uuid)[0]).toMatchObject({
      commit_sha: gone,
      status: CommentRelocationStatus.Orphaned,
    });
  });
});
