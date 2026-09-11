/**
 * Integration tests for relocateComments() - a real temp git repo (so
 * computeCommitCorrespondence/getFileAtCommit run against actual git
 * plumbing) plus an isolated test database.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set up test database path before importing database module - see the
// same pattern in __tests__/database.test.ts.
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-relocation-test-'));
process.env.DATABASE_DIR = testDbDir;
process.env.DATABASE_PATH = path.join(testDbDir, 'test.db');

import { relocateComments } from '../lib/comment-relocation';
import {
  addComment,
  closeDatabase,
  createPR,
  getComments,
  getReviewedFiles,
  lookupCommitRelocation,
  setReviewedFile,
} from '../lib/database';
import { CommentRelocationStatus, CommentTargetType, LineType } from '../lib/enum';
import { getBlobHash } from '../lib/git';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function commitWithDate(cwd: string, message: string, date: string): string {
  execFileSync('git', ['commit', '-m', message], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

describe('relocateComments', () => {
  let repoDir: string;
  let base: string;
  let oldCommitA: string;
  let oldCommitB: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-relocation-repo-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    base = commitWithDate(repoDir, 'base commit', '2024-01-01T00:00:00');

    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line one\nline two\nline three\n');
    runGit(repoDir, ['add', 'a.txt']);
    oldCommitA = commitWithDate(repoDir, 'add a', '2024-01-02T00:00:00');

    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    oldCommitB = commitWithDate(repoDir, 'add b', '2024-01-03T00:00:00');
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(testDbDir, { recursive: true, force: true });
  });

  test('relocates a commit-message comment and a per-commit line comment across a pure rebase', () => {
    const prUuid = createPR(repoDir, 'Relocation PR', 'main', 'feature', base, oldCommitB, 'diff');

    const commitMessageUuid = addComment(
      prUuid,
      '',
      0,
      'nice commit',
      LineType.New,
      0,
      oldCommitA,
      CommentTargetType.CommitMessage,
    );
    const lineUuid = addComment(
      prUuid,
      'a.txt',
      2,
      'about line two',
      LineType.New,
      2,
      oldCommitA,
      CommentTargetType.Line,
      { content: 'line two', contextBefore: 'line one', contextAfter: 'line three' },
    );

    // Simulate a rebase: replay the exact same diffs/messages on top of the
    // same base, at a later date - same patch-id, different SHA.
    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line one\nline two\nline three\n');
    runGit(repoDir, ['add', 'a.txt']);
    const newCommitA = commitWithDate(repoDir, 'add a', '2024-02-01T00:00:00');

    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    const newCommitB = commitWithDate(repoDir, 'add b', '2024-02-02T00:00:00');

    expect(newCommitA).not.toBe(oldCommitA);

    relocateComments(prUuid, repoDir, base, oldCommitB, base, newCommitB);

    const comments = getComments(prUuid);
    const commitMessageComment = comments.find((c) => c.uuid === commitMessageUuid);
    const lineComment = comments.find((c) => c.uuid === lineUuid);

    expect(commitMessageComment?.commit_sha).toBe(newCommitA);
    expect(commitMessageComment?.status).toBe(CommentRelocationStatus.Active);

    expect(lineComment?.commit_sha).toBe(newCommitA);
    expect(lineComment?.line_number).toBe(2);
    expect(lineComment?.status).toBe(CommentRelocationStatus.Active);

    // The mapping is durable, independent of any comment - a stale
    // `?commit=` link for oldCommitA should resolve to newCommitA.
    expect(lookupCommitRelocation(prUuid, oldCommitA)).toBe(newCommitA);
  });

  test('relocates a line comment within the same commit when content shifted (amend)', () => {
    const prUuid = createPR(repoDir, 'Amend PR', 'main', 'feature', base, oldCommitA, 'diff');

    const lineUuid = addComment(
      prUuid,
      'a.txt',
      2,
      'about line two',
      LineType.New,
      2,
      oldCommitA,
      CommentTargetType.Line,
      { content: 'line two', contextBefore: 'line one', contextAfter: 'line three' },
    );

    // Amend: same message, but a line inserted above shifts "line two" down
    // by one - patch-id can't match this (content changed), but the message
    // fallback should, and the anchor search should re-find the line.
    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(
      path.join(repoDir, 'a.txt'),
      'inserted line\nline one\nline two\nline three\n',
    );
    runGit(repoDir, ['add', 'a.txt']);
    const amendedA = commitWithDate(repoDir, 'add a', '2024-02-01T00:00:00');

    relocateComments(prUuid, repoDir, base, oldCommitA, base, amendedA);

    const relocated = getComments(prUuid).find((c) => c.uuid === lineUuid);
    expect(relocated?.commit_sha).toBe(amendedA);
    expect(relocated?.line_number).toBe(3); // shifted down by the inserted line
    expect(relocated?.status).toBe(CommentRelocationStatus.Active);
  });

  test('orphans a comment whose commit was dropped entirely', () => {
    const prUuid = createPR(repoDir, 'Drop PR', 'main', 'feature', base, oldCommitB, 'diff');

    const commitMessageUuid = addComment(
      prUuid,
      '',
      0,
      'comment on a commit about to be dropped',
      LineType.New,
      0,
      oldCommitB,
      CommentTargetType.CommitMessage,
    );

    // Rebase that drops "add b" entirely (e.g. `rebase -i` with `drop`) -
    // only "add a" survives, replayed onto the same base.
    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line one\nline two\nline three\n');
    runGit(repoDir, ['add', 'a.txt']);
    const survivingA = commitWithDate(repoDir, 'add a', '2024-02-01T00:00:00');

    relocateComments(prUuid, repoDir, base, oldCommitB, base, survivingA);

    const orphaned = getComments(prUuid).find((c) => c.uuid === commitMessageUuid);
    expect(orphaned?.commit_sha).toBe(oldCommitB); // frozen at the last-known (now-gone) SHA
    expect(orphaned?.status).toBe(CommentRelocationStatus.Orphaned);
    expect(lookupCommitRelocation(prUuid, oldCommitB)).toBeNull();
  });

  test("relocates a comment's paired (cross-side) range by the same delta as its primary range", () => {
    const prUuid = createPR(
      repoDir,
      'Paired Range PR',
      'main',
      'feature',
      base,
      oldCommitA,
      'diff',
    );

    const commentUuid = addComment(
      prUuid,
      'a.txt',
      2,
      'a paired comment',
      LineType.New,
      2,
      oldCommitA,
      CommentTargetType.Line,
      { content: 'line two', contextBefore: 'line one', contextAfter: 'line three' },
      1,
      1,
    );

    // Amend: insert a line above, shifting every line - primary and paired
    // alike - down by one.
    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(
      path.join(repoDir, 'a.txt'),
      'inserted line\nline one\nline two\nline three\n',
    );
    runGit(repoDir, ['add', 'a.txt']);
    const amendedA = commitWithDate(repoDir, 'add a', '2024-02-01T00:00:02');

    relocateComments(prUuid, repoDir, base, oldCommitA, base, amendedA);

    const relocated = getComments(prUuid).find((c) => c.uuid === commentUuid);
    expect(relocated?.line_number).toBe(3);
    expect(relocated?.paired_line_number).toBe(2);
    expect(relocated?.paired_end_line_number).toBe(2);
    expect(relocated?.status).toBe(CommentRelocationStatus.Active);
  });

  test('is a no-op when the commit range has not actually changed', () => {
    const prUuid = createPR(repoDir, 'No-op PR', 'main', 'feature', base, oldCommitA, 'diff');
    const commentUuid = addComment(
      prUuid,
      'a.txt',
      2,
      'a comment',
      LineType.New,
      2,
      oldCommitA,
      CommentTargetType.Line,
      { content: 'line two', contextBefore: 'line one', contextAfter: 'line three' },
    );

    relocateComments(prUuid, repoDir, base, oldCommitA, base, oldCommitA);

    const unchanged = getComments(prUuid).find((c) => c.uuid === commentUuid);
    expect(unchanged?.commit_sha).toBe(oldCommitA);
    expect(unchanged?.line_number).toBe(2);
    expect(unchanged?.status).toBe(CommentRelocationStatus.Active);
  });

  // A per-commit reviewed mark is keyed by SHA, so before relocation a rebase
  // silently reset every one of them - the content_hash check alone couldn't
  // save a mark whose commit no longer existed under that name.
  test('carries a per-commit reviewed mark onto the rewritten SHA across a pure rebase', () => {
    const prUuid = createPR(
      repoDir,
      'Reviewed Rebase PR',
      'main',
      'feature',
      base,
      oldCommitB,
      'd',
    );
    const markedHash = getBlobHash(repoDir, oldCommitA, 'a.txt');
    setReviewedFile(prUuid, 'a.txt', oldCommitA, markedHash as string);

    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line one\nline two\nline three\n');
    runGit(repoDir, ['add', 'a.txt']);
    const newCommitA = commitWithDate(repoDir, 'add a', '2024-03-01T00:00:00');
    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b\n');
    runGit(repoDir, ['add', 'b.txt']);
    const newCommitB = commitWithDate(repoDir, 'add b', '2024-03-02T00:00:00');
    expect(newCommitA).not.toBe(oldCommitA);

    relocateComments(prUuid, repoDir, base, oldCommitB, base, newCommitB);

    const marks = getReviewedFiles(prUuid);
    expect(marks).toHaveLength(1);
    expect(marks[0].commit_sha).toBe(newCommitA);
    // Still current: the rebase moved the SHA but not a byte of a.txt, which
    // is what the PR route compares to decide whether the mark still counts.
    expect(getBlobHash(repoDir, newCommitA, 'a.txt')).toBe(marks[0].content_hash);
  });

  test('moves a mark whose file the amend rewrote, but leaves it content-stale', () => {
    const prUuid = createPR(repoDir, 'Reviewed Amend PR', 'main', 'feature', base, oldCommitA, 'd');
    setReviewedFile(
      prUuid,
      'a.txt',
      oldCommitA,
      getBlobHash(repoDir, oldCommitA, 'a.txt') as string,
    );

    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line one\nline two CHANGED\nline three\n');
    runGit(repoDir, ['add', 'a.txt']);
    const amendedA = commitWithDate(repoDir, 'add a', '2024-03-03T00:00:00');

    relocateComments(prUuid, repoDir, base, oldCommitA, base, amendedA);

    const marks = getReviewedFiles(prUuid);
    expect(marks).toHaveLength(1);
    expect(marks[0].commit_sha).toBe(amendedA);
    // Relocated but no longer current - the reviewer has to look again,
    // which is exactly what should happen when the content really changed.
    expect(getBlobHash(repoDir, amendedA, 'a.txt')).not.toBe(marks[0].content_hash);
  });

  test('leaves a mark on its old SHA when the commit was dropped, and leaves cumulative marks alone', () => {
    const prUuid = createPR(repoDir, 'Reviewed Drop PR', 'main', 'feature', base, oldCommitB, 'd');
    setReviewedFile(
      prUuid,
      'b.txt',
      oldCommitB,
      getBlobHash(repoDir, oldCommitB, 'b.txt') as string,
    );
    setReviewedFile(prUuid, 'a.txt', null, getBlobHash(repoDir, oldCommitB, 'a.txt') as string);

    // Rebase that drops "add b" entirely - nothing for b.txt's mark to move to.
    runGit(repoDir, ['-c', 'advice.detachedHead=false', 'checkout', base]);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line one\nline two\nline three\n');
    runGit(repoDir, ['add', 'a.txt']);
    const survivingA = commitWithDate(repoDir, 'add a', '2024-03-04T00:00:00');

    relocateComments(prUuid, repoDir, base, oldCommitB, base, survivingA);

    const marks = getReviewedFiles(prUuid);
    expect(marks.find((m) => m.file_path === 'b.txt')?.commit_sha).toBe(oldCommitB);
    // Cumulative marks were never SHA-keyed, so relocation must not touch them.
    expect(marks.find((m) => m.file_path === 'a.txt')?.commit_sha).toBeNull();
  });
});
