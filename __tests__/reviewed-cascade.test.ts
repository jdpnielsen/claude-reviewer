/**
 * Reviewed marks cascading between an autosquash preview commit and the PR
 * commits folded into it - derived on read by GET /api/prs/[id], and
 * unmarked through the same links by the reviewed DELETE routes.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set up test database path before importing database module - see the
// same pattern in __tests__/database.test.ts.
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-cascade-test-'));
process.env.DATABASE_DIR = testDbDir;
process.env.DATABASE_PATH = path.join(testDbDir, 'test.db');

import { DELETE as unmarkCommitRoute } from '../app/api/prs/[id]/reviewed/commit/route';
import { DELETE as unmarkMessageRoute } from '../app/api/prs/[id]/reviewed/message/route';
import { DELETE as unmarkFileRoute } from '../app/api/prs/[id]/reviewed/route';
import { GET as prGetRoute } from '../app/api/prs/[id]/route';
import {
  closeDatabase,
  createPR,
  getReviewedCommitMessages,
  getReviewedFiles,
  setReviewedCommitMessage,
  setReviewedFile,
} from '../lib/database';
import { autosquashCommits, getBlobHash, getCommitMessageHash } from '../lib/git';
import { deriveReviewedMarks, type CascadeGroup } from '../lib/reviewed-cascade';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

interface Mark {
  file_path?: string;
  commit_sha: string;
  current: boolean;
  via?: string;
}

describe('reviewed marks across the autosquash preview', () => {
  let repoDir: string;
  let base: string;
  let addA: string;
  let fixup: string;
  let squashed: string;
  let uuid: string;

  function commit(message: string, write: Record<string, string | null>): string {
    for (const [file, content] of Object.entries(write)) {
      if (content === null) runGit(repoDir, ['rm', '-q', file]);
      else {
        fs.writeFileSync(path.join(repoDir, file), content);
        runGit(repoDir, ['add', file]);
      }
    }
    runGit(repoDir, ['commit', '-q', '-m', message]);
    return runGit(repoDir, ['rev-parse', 'HEAD']);
  }

  const params = () => ({ params: Promise.resolve({ id: uuid }) });

  async function getPR() {
    const res = await prGetRoute(new Request(`http://test/api/prs/${uuid}`) as never, params());
    return res.json();
  }

  const markFile = (file: string, sha: string) =>
    setReviewedFile(uuid, file, sha, getBlobHash(repoDir, sha, file) ?? 'deleted');
  const markMessage = (sha: string) =>
    setReviewedCommitMessage(uuid, sha, getCommitMessageHash(repoDir, sha)!);

  const fileMark = (marks: Mark[], file: string, sha: string) =>
    marks.find((m) => m.file_path === file && m.commit_sha === sha && m.current);
  const messageMark = (marks: Mark[], sha: string) =>
    marks.find((m) => m.commit_sha === sha && m.current);

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-cascade-repo-'));
    runGit(repoDir, ['init', '-q', '-b', 'main']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);
    runGit(repoDir, ['config', 'commit.gpgSign', 'false']);
    base = commit('base commit', { 'base.txt': 'base\n' });
    runGit(repoDir, ['checkout', '-q', '-b', 'feature']);
    // "add a" also adds c.txt, which its fixup takes back out again - so the
    // squashed commit never touches c.txt at all.
    addA = commit('add a', { 'a.txt': 'one\n', 'c.txt': 'scratch\n' });
    commit('add b', { 'b.txt': 'b\n' });
    fixup = commit('fixup! add a', { 'a.txt': 'one\ntwo\n', 'c.txt': null });
    uuid = createPR(repoDir, 'cascade', 'main', 'feature', base, fixup, 'diff');
    squashed = autosquashCommits(repoDir, base, fixup).commits[0].sha;
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(testDbDir, { recursive: true, force: true });
  });

  test('marks on every commit that touches a file cover the squashed commit', async () => {
    markFile('a.txt', addA);
    expect(fileMark((await getPR()).reviewedFiles, 'a.txt', squashed)).toBeUndefined();

    markFile('a.txt', fixup);
    markMessage(addA);
    const data = await getPR();
    expect(fileMark(data.reviewedFiles, 'a.txt', squashed)).toMatchObject({ via: 'commits' });
    expect(messageMark(data.reviewedMessages, squashed)).toMatchObject({ via: 'commits' });
    // All of the squashed commit is covered: its message and its only file.
    expect(data.reviewedCommits).toContain(squashed);
    // Nothing is stored for it - it's derived.
    expect(getReviewedFiles(uuid).map((r) => r.commit_sha)).not.toContain(squashed);
  });

  test("the squashed commit's marks cover each commit's share, but not what it cancels out", async () => {
    markFile('a.txt', squashed);
    markMessage(squashed);
    const data = await getPR();

    expect(fileMark(data.reviewedFiles, 'a.txt', addA)).toMatchObject({ via: 'preview' });
    expect(fileMark(data.reviewedFiles, 'a.txt', fixup)).toMatchObject({ via: 'preview' });
    expect(fileMark(data.reviewedFiles, 'c.txt', addA)).toBeUndefined();
    expect(fileMark(data.reviewedFiles, 'c.txt', fixup)).toBeUndefined();
    // The fixup's message only points at "add a", so it's covered too.
    expect(messageMark(data.reviewedMessages, addA)).toMatchObject({ via: 'preview' });
    expect(messageMark(data.reviewedMessages, fixup)).toMatchObject({ via: 'preview' });
    // c.txt is still to review in both.
    expect(data.reviewedCommits).toEqual([squashed]);
  });

  test('unmarking a derived mark unmarks what it came from', async () => {
    markFile('a.txt', squashed);
    markMessage(squashed);

    const res = await unmarkFileRoute(
      new Request(`http://test/api/prs/${uuid}/reviewed?file=a.txt&commit=${addA}`) as never,
      params(),
    );
    expect(res.status).toBe(200);
    expect(getReviewedFiles(uuid)).toEqual([]);

    const msg = await unmarkMessageRoute(
      new Request(`http://test/api/prs/${uuid}/reviewed/message?commit=${fixup}`) as never,
      params(),
    );
    expect(msg.status).toBe(200);
    expect(getReviewedCommitMessages(uuid)).toEqual([]);
  });

  test('unmarking the squashed commit unmarks the commits it was derived from', async () => {
    markFile('a.txt', addA);
    markFile('c.txt', addA);
    markFile('a.txt', fixup);
    markMessage(addA);
    markMessage(fixup);

    const res = await unmarkCommitRoute(
      new Request(`http://test/api/prs/${uuid}/reviewed/commit?commit=${squashed}`) as never,
      params(),
    );
    expect(res.status).toBe(200);
    // c.txt isn't part of the squashed commit, so its mark stays.
    expect(getReviewedFiles(uuid).map((r) => [r.file_path, r.commit_sha])).toEqual([
      ['c.txt', addA],
    ]);
    expect(getReviewedCommitMessages(uuid)).toEqual([]);
  });
});

describe('deriveReviewedMarks', () => {
  const group: CascadeGroup = {
    sha: 'S',
    members: ['t', 'f'],
    messageSources: ['t'],
    messageCovers: ['t', 'f'],
  };
  const filesOf = (sha: string) => (sha === 'f' ? ['x'] : ['x', 'y']);
  const mark = (file_path: string, commit_sha: string, current = true) => ({
    file_path,
    commit_sha,
    current,
    marked_at: '2026-01-01',
  });

  test("a stale mark doesn't cascade", () => {
    const { files } = deriveReviewedMarks([group], [mark('x', 'S', false)], [], filesOf);
    expect(files).toEqual([]);
  });

  test("a derived mark doesn't cascade further", () => {
    // t's x is marked, f's isn't: S's x isn't derived, so neither is f's.
    const { files } = deriveReviewedMarks([group], [mark('x', 't')], [], filesOf);
    expect(files).toEqual([]);
  });

  test("a mark that's stored isn't derived as well", () => {
    const { files } = deriveReviewedMarks([group], [mark('x', 'S'), mark('x', 't')], [], filesOf);
    expect(files.map((m) => m.commit_sha)).toEqual(['f']);
  });
});
