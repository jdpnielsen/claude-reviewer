/**
 * Tests for the PR API route handlers. These exercise the new HTTP-layer
 * behavior added alongside the Conversation tab work: the PATCH status guards,
 * the branch-resync endpoint, and the `excludeClosed` list filter. The handlers
 * are invoked directly (Next.js route handlers are just async functions), each
 * one hitting a temp SQLite DB isolated via DATABASE_PATH.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Point the database module at a throwaway DB before it is imported. Resolution
// is lazy inside getDatabase(), but setting this before the first call keeps the
// real ~/.claude-reviewer/data.db untouched.
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-api-test-'));
process.env.DATABASE_DIR = testDbDir;
process.env.DATABASE_PATH = path.join(testDbDir, 'test.db');

import { GET as contextRoute } from '../app/api/prs/[id]/context/route';
import { POST as reviewRoute } from '../app/api/prs/[id]/review/route';
import {
  DELETE as reviewedCommitDeleteRoute,
  POST as reviewedCommitRoute,
} from '../app/api/prs/[id]/reviewed/commit/route';
import {
  DELETE as reviewedMessageDeleteRoute,
  POST as reviewedMessageRoute,
} from '../app/api/prs/[id]/reviewed/message/route';
import { POST as reviewedFileRoute } from '../app/api/prs/[id]/reviewed/route';
import { DELETE as prDeleteRoute, GET as prGetRoute, PATCH } from '../app/api/prs/[id]/route';
import { POST as syncRoute } from '../app/api/prs/[id]/sync/route';
import { GET as listPRsRoute } from '../app/api/prs/route';
import {
  addComment,
  addReply,
  createPR,
  getDatabase,
  getCommentsWithReplies,
  getPRByUuid,
  getLatestDiff,
  resolveComment,
  setReviewedCommitMessage,
  submitReview,
  updatePRStatus,
  upsertCommitRelocation,
  closeDatabase,
} from '../lib/database';
import { CommentTargetType, PullRequestStatus, ReviewAction } from '../lib/enum';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

// Next route handlers take a NextRequest; a plain Request is structurally
// sufficient for the fields these handlers read (url + json()).
function patchReq(id: string, body: unknown): Request {
  return new Request(`http://test/api/prs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function postReq(id: string, body: unknown): Request {
  return new Request(`http://test/api/prs/${id}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

afterAll(() => {
  closeDatabase();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

describe('PATCH /api/prs/[id]', () => {
  test('returns 404 for a non-existent PR', async () => {
    const res = await PATCH(
      patchReq('nope', { status: PullRequestStatus.Approved }) as never,
      routeParams('nope'),
    );
    expect(res.status).toBe(404);
  });

  test('rejects an invalid status with 400 and leaves the PR unchanged', async () => {
    const uuid = createPR('/repo/api', 'PATCH invalid', 'main', 'f', 'a', 'b', 'diff');
    const res = await PATCH(patchReq(uuid, { status: 'bogus' }) as never, routeParams(uuid));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid status: bogus');
    // Status must not have been written.
    expect(getPRByUuid(uuid)?.status).toBe(PullRequestStatus.Pending);
  });

  test('updates a valid status on a non-terminal PR', async () => {
    const uuid = createPR('/repo/api', 'PATCH valid', 'main', 'f', 'a', 'b', 'diff');
    const res = await PATCH(
      patchReq(uuid, { status: PullRequestStatus.Closed }) as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pr.status).toBe(PullRequestStatus.Closed);
    expect(getPRByUuid(uuid)?.status).toBe(PullRequestStatus.Closed);
  });

  test('reopening a closed PR is allowed (closed is not terminal)', async () => {
    const uuid = createPR('/repo/api', 'reopen', 'main', 'f', 'a', 'b', 'diff');
    updatePRStatus(uuid, PullRequestStatus.Closed);

    const res = await PATCH(
      patchReq(uuid, { status: PullRequestStatus.Pending }) as never,
      routeParams(uuid),
    );
    expect(res.status).toBe(200);
    expect(getPRByUuid(uuid)?.status).toBe(PullRequestStatus.Pending);
  });

  test('refuses to change the status of a merged PR with 409', async () => {
    const uuid = createPR('/repo/api', 'merged', 'main', 'f', 'a', 'b', 'diff');
    updatePRStatus(uuid, PullRequestStatus.Merged);

    const res = await PATCH(
      patchReq(uuid, { status: PullRequestStatus.Pending }) as never,
      routeParams(uuid),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('Cannot change the status of a merged PR');
    // The merged status is preserved.
    expect(getPRByUuid(uuid)?.status).toBe(PullRequestStatus.Merged);
  });

  test('a body without a status is a no-op that still returns the PR', async () => {
    const uuid = createPR('/repo/api', 'no status', 'main', 'f', 'a', 'b', 'diff');
    const res = await PATCH(patchReq(uuid, {}) as never, routeParams(uuid));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pr.uuid).toBe(uuid);
    expect(getPRByUuid(uuid)?.status).toBe(PullRequestStatus.Pending);
  });
});

describe('POST /api/prs/[id]/sync', () => {
  let repoDir: string;
  let baseCommit: string;
  let headCommitBefore: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-api-repo-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base commit']);
    runGit(repoDir, ['branch', '-M', 'main']);
    baseCommit = runGit(repoDir, ['rev-parse', 'HEAD']);

    runGit(repoDir, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'first\n');
    runGit(repoDir, ['add', 'feature.txt']);
    runGit(repoDir, ['commit', '-m', 'feature v1']);
    headCommitBefore = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('returns 404 for a non-existent PR', async () => {
    const res = await syncRoute({} as never, routeParams('nope'));
    expect(res.status).toBe(404);
  });

  test('re-pulls the branch diff, bumps the revision, and resets to pending', async () => {
    // The PR is created against feature v1, then approved. A new commit lands on
    // the branch; sync should pick it up and re-open review.
    const uuid = createPR(
      repoDir,
      'sync me',
      'main',
      'feature',
      baseCommit,
      headCommitBefore,
      'stale diff',
    );
    updatePRStatus(uuid, PullRequestStatus.Approved);

    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'first\nsecond\n');
    runGit(repoDir, ['add', 'feature.txt']);
    runGit(repoDir, ['commit', '-m', 'feature v2']);
    const headCommitAfter = runGit(repoDir, ['rev-parse', 'HEAD']);

    const res = await syncRoute({} as never, routeParams(uuid));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.revision).toBe(2);
    expect(json.headCommit).toBe(headCommitAfter);
    expect(json.status).toBe(PullRequestStatus.Pending);

    // The stored diff reflects the new commit, head_commit is advanced, and the
    // approval was reset so the change gets re-reviewed.
    const pr = getPRByUuid(uuid);
    expect(pr?.status).toBe(PullRequestStatus.Pending);
    expect(pr?.head_commit).toBe(headCommitAfter);
    const diff = getLatestDiff(uuid);
    expect(diff).toContain('feature.txt');
    expect(diff).toContain('second');
    // base_commit stays pinned to the original fork point (matches the CLI).
    expect(pr?.base_commit).toBe(baseCommit);
  });

  test('refuses to sync a merged PR with 409', async () => {
    const uuid = createPR(
      repoDir,
      'merged sync',
      'main',
      'feature',
      baseCommit,
      headCommitBefore,
      'diff',
    );
    updatePRStatus(uuid, PullRequestStatus.Merged);

    const res = await syncRoute({} as never, routeParams(uuid));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('Cannot sync a merged PR');
  });
});

describe('GET /api/prs/[id] - stale ?commit= handling', () => {
  let repoDir: string;
  let baseCommit: string;
  let headCommit: string;

  function getReq(id: string, query: string): Request {
    return new Request(`http://test/api/prs/${id}${query}`);
  }

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-api-commit-repo-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base commit']);
    runGit(repoDir, ['branch', '-M', 'main']);
    baseCommit = runGit(repoDir, ['rev-parse', 'HEAD']);

    runGit(repoDir, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'first\n');
    runGit(repoDir, ['add', 'feature.txt']);
    runGit(repoDir, ['commit', '-m', 'feature v1']);
    headCommit = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('a stale commit with a known relocation comes back as relocatedTo', async () => {
    const uuid = createPR(repoDir, 'stale link', 'main', 'feature', baseCommit, headCommit, 'diff');
    const staleSha = '1111111111111111111111111111111111111111';
    upsertCommitRelocation(uuid, staleSha, headCommit);

    const res = await prGetRoute(getReq(uuid, `?commit=${staleSha}`) as never, routeParams(uuid));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Unknown commit for this PR');
    expect(json.relocatedTo).toBe(headCommit);
  });

  test('relocatedTo is null when no relocation is known for the SHA', async () => {
    const uuid = createPR(
      repoDir,
      'truly unknown commit',
      'main',
      'feature',
      baseCommit,
      headCommit,
      'diff',
    );
    const unknownSha = '2222222222222222222222222222222222222222';

    const res = await prGetRoute(getReq(uuid, `?commit=${unknownSha}`) as never, routeParams(uuid));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Unknown commit for this PR');
    expect(json.relocatedTo).toBeNull();
  });

  test('a valid commit still returns its diff normally', async () => {
    const uuid = createPR(
      repoDir,
      'valid commit',
      'main',
      'feature',
      baseCommit,
      headCommit,
      'diff',
    );

    const res = await prGetRoute(getReq(uuid, `?commit=${headCommit}`) as never, routeParams(uuid));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toContain('feature.txt');
  });
});

describe('GET /api/prs excludeClosed', () => {
  function listReq(query: string): Request {
    return new Request(`http://test/api/prs${query}`);
  }

  test('excludeClosed=true hides closed PRs; the default listing includes them', async () => {
    const openUuid = createPR('/repo/list', 'list open', 'main', 'f', 'a', 'b', 'd');
    const closedUuid = createPR('/repo/list', 'list closed', 'main', 'f', 'a', 'b', 'd');
    updatePRStatus(closedUuid, PullRequestStatus.Closed);

    const defaultRes = await listPRsRoute(listReq('?repo=/repo/list') as never);
    const defaultUuids = (await defaultRes.json()).prs.map((pr: { uuid: string }) => pr.uuid);
    expect(defaultUuids).toEqual(expect.arrayContaining([openUuid, closedUuid]));

    const filteredRes = await listPRsRoute(listReq('?repo=/repo/list&excludeClosed=true') as never);
    const filteredUuids = (await filteredRes.json()).prs.map((pr: { uuid: string }) => pr.uuid);
    expect(filteredUuids).toContain(openUuid);
    expect(filteredUuids).not.toContain(closedUuid);
  });
});

// A PR outlives its checkout: created inside a throwaway worktree, or in a clone
// that later moved, its repo_path points at a directory that isn't there any
// more. Every git call in that cwd fails as a bare `spawnSync git ENOENT`, which
// used to 500 the GET handler and put the PR permanently out of reach - unable
// to be viewed, and (before DELETE existed) unable to be removed either.
describe('GET /api/prs/[id] - repository no longer available', () => {
  let goneDir: string;
  let emptyDir: string;
  let liveDir: string;
  let liveBase: string;
  let liveHead: string;

  function getReq(id: string, query = ''): Request {
    return new Request(`http://test/api/prs/${id}${query}`);
  }

  beforeAll(() => {
    // Existed once, deleted since - the removed-worktree case.
    goneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-gone-repo-'));
    fs.rmSync(goneDir, { recursive: true, force: true });

    // Still a directory, but no .git - a leftover empty worktree dir, just as
    // unusable as a missing one.
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-empty-repo-'));

    liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-live-repo-'));
    runGit(liveDir, ['init']);
    runGit(liveDir, ['config', 'user.email', 'test@example.com']);
    runGit(liveDir, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(liveDir, 'base.txt'), 'base\n');
    runGit(liveDir, ['add', 'base.txt']);
    runGit(liveDir, ['commit', '-m', 'base commit']);
    runGit(liveDir, ['branch', '-M', 'main']);
    liveBase = runGit(liveDir, ['rev-parse', 'HEAD']);
    runGit(liveDir, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(liveDir, 'feature.txt'), 'first\n');
    runGit(liveDir, ['add', 'feature.txt']);
    runGit(liveDir, ['commit', '-m', 'feature v1']);
    liveHead = runGit(liveDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.rmSync(liveDir, { recursive: true, force: true });
  });

  test('serves the stored diff and metadata rather than 500ing on the failed git call', async () => {
    const uuid = createPR(
      goneDir,
      'gone repo',
      'main',
      'feature',
      'aaa',
      'bbb',
      'stored diff body',
    );
    addComment(uuid, 'feature.txt', 1, 'still readable');

    const res = await prGetRoute(getReq(uuid) as never, routeParams(uuid));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.repoAvailable).toBe(false);
    // The DB can still answer all of this; only the git-backed parts are lost.
    expect(json.pr.uuid).toBe(uuid);
    expect(json.diff).toBe('stored diff body');
    expect(json.comments).toHaveLength(1);
    expect(json.commits).toEqual([]);
  });

  test('an existing directory that is not a git repo counts as unavailable too', async () => {
    const uuid = createPR(emptyDir, 'empty dir', 'main', 'feature', 'aaa', 'bbb', 'stored diff');

    const res = await prGetRoute(getReq(uuid) as never, routeParams(uuid));

    expect(res.status).toBe(200);
    expect((await res.json()).repoAvailable).toBe(false);
  });

  test('?commit= is ignored instead of 400ing the client into the relocation path', async () => {
    const uuid = createPR(
      goneDir,
      'gone with commit',
      'main',
      'feature',
      'aaa',
      'bbb',
      'cumulative',
    );
    const someSha = '3333333333333333333333333333333333333333';

    const res = await prGetRoute(getReq(uuid, `?commit=${someSha}`) as never, routeParams(uuid));

    // Not a 400 'Unknown commit for this PR': the commit may well be genuine,
    // there is just no repo left to read it out of, so the cumulative stored
    // diff is all that can be served.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.repoAvailable).toBe(false);
    expect(json.diff).toBe('cumulative');
  });

  test('a live checkout still reports repoAvailable and its real commit list', async () => {
    const uuid = createPR(liveDir, 'live repo', 'main', 'feature', liveBase, liveHead, 'diff');

    const res = await prGetRoute(getReq(uuid) as never, routeParams(uuid));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.repoAvailable).toBe(true);
    expect(json.commits.map((c: { sha: string }) => c.sha)).toEqual([liveHead]);
  });

  test('sync refuses with 409 rather than surfacing a bare ENOENT', async () => {
    const uuid = createPR(goneDir, 'gone sync', 'main', 'feature', 'aaa', 'bbb', 'diff');

    const res = await syncRoute({} as never, routeParams(uuid));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('no longer available');
    // The stored snapshot is untouched by the refusal.
    expect(getLatestDiff(uuid)).toBe('diff');
  });
});

describe('DELETE /api/prs/[id]', () => {
  function childRowCounts(prId: number) {
    const db = getDatabase();
    const countBy = (table: string, column: string, value: number) =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
          n: number;
        }
      ).n;
    return {
      diffs: countBy('diff_snapshots', 'pr_id', prId),
      comments: countBy('comments', 'pr_id', prId),
      reviews: countBy('reviews', 'pr_id', prId),
    };
  }

  // comment_replies hangs off comments rather than the PR, so counting it needs
  // the join - and covers the second hop of the cascade. Re-resolves the
  // connection on every call rather than closing over one: getDatabase()
  // reconnects (checkpoint/close), and a captured handle goes stale.
  function replyCount(prId: number): number {
    const row = getDatabase()
      .prepare(
        'SELECT COUNT(*) AS n FROM comment_replies' +
          ' WHERE comment_id IN (SELECT id FROM comments WHERE pr_id = ?)',
      )
      .get(prId) as { n: number };
    return row.n;
  }

  test('returns 404 for a non-existent PR', async () => {
    const res = await prDeleteRoute({} as never, routeParams('nope'));
    expect(res.status).toBe(404);
  });

  test('removes a PR whose repo path is gone, cascading to all its review data', async () => {
    // The case this endpoint exists for: no git anywhere in the delete path, so
    // a PR left behind by a deleted worktree can still be cleared out.
    const uuid = createPR(
      '/tmp/definitely-not-here',
      'delete me',
      'main',
      'feature',
      'aaa',
      'bbb',
      'diff',
    );
    const prId = getPRByUuid(uuid)!.id;
    const commentUuid = addComment(uuid, 'feature.txt', 1, 'a comment');
    addReply(commentUuid, 'a reply');
    submitReview(uuid, ReviewAction.Approve, 'looks good');

    expect(childRowCounts(prId)).toEqual({ diffs: 1, comments: 1, reviews: 1 });
    expect(replyCount(prId)).toBe(1);

    const res = await prDeleteRoute({} as never, routeParams(uuid));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(getPRByUuid(uuid)).toBeFalsy();
    // Cascades are only enforced by the foreign_keys pragma - without it these
    // rows would silently outlive the PR.
    expect(childRowCounts(prId)).toEqual({ diffs: 0, comments: 0, reviews: 0 });
    expect(replyCount(prId)).toBe(0);
  });

  test('deletes a merged PR too - unlike PATCH, this is not a state transition', async () => {
    const uuid = createPR('/repo/api', 'merged delete', 'main', 'f', 'a', 'b', 'diff');
    updatePRStatus(uuid, PullRequestStatus.Merged);

    const res = await prDeleteRoute({} as never, routeParams(uuid));

    expect(res.status).toBe(200);
    expect(getPRByUuid(uuid)).toBeFalsy();
  });
});

describe('POST /api/prs/[id]/review', () => {
  test('a request_changes review with a summary is mirrored into a repliable comment', async () => {
    const uuid = createPR('/repo/api', 'review with summary', 'main', 'f', 'a', 'b', 'diff');

    const res = await reviewRoute(
      postReq(uuid, { action: ReviewAction.RequestChanges, summary: 'please add tests' }) as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(200);
    const comments = getCommentsWithReplies(uuid);
    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toMatchObject({
      target_type: CommentTargetType.ReviewSummary,
      content: 'please add tests',
      review_action: ReviewAction.RequestChanges,
    });
    expect(Boolean(comments[0].comment.resolved)).toBe(false);
  });

  test('an approve review with a summary is mirrored into a comment too, tagged with its action', async () => {
    const uuid = createPR('/repo/api', 'approve with summary', 'main', 'f', 'a', 'b', 'diff');

    const res = await reviewRoute(
      postReq(uuid, { action: ReviewAction.Approve, summary: 'looks great' }) as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(200);
    const comments = getCommentsWithReplies(uuid);
    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toMatchObject({
      target_type: CommentTargetType.ReviewSummary,
      content: 'looks great',
      review_action: ReviewAction.Approve,
    });
  });

  test('a review with no summary creates no comment', async () => {
    const uuid = createPR('/repo/api', 'review without summary', 'main', 'f', 'a', 'b', 'diff');

    const res = await reviewRoute(
      postReq(uuid, { action: ReviewAction.RequestChanges }) as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(200);
    expect(getCommentsWithReplies(uuid)).toHaveLength(0);
  });

  test('a line comment created outside a review has no review_action', async () => {
    const uuid = createPR('/repo/api', 'plain line comment', 'main', 'f', 'a', 'b', 'diff');
    addComment(uuid, 'a.py', 1, 'looks fine');

    const comments = getCommentsWithReplies(uuid);
    expect(comments[0].comment.review_action).toBeNull();
  });
});

// The server half of "show 10 more lines": a single commit's diff is
// `sha^..sha`, so its line numbers index the file at that commit. Without an
// explicit ?commit= the route falls back to the PR head, which is how
// expanding context inside an older commit's diff used to splice in text from
// a later commit.
describe('GET /api/prs/[id]/context', () => {
  let repoDir: string;
  let baseCommit: string;
  let firstCommit: string;
  let headCommit: string;

  function contextReq(id: string, query: string): Request {
    return new Request(`http://test/api/prs/${id}/context${query}`);
  }

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-api-context-repo-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base commit']);
    runGit(repoDir, ['branch', '-M', 'main']);
    baseCommit = runGit(repoDir, ['rev-parse', 'HEAD']);

    runGit(repoDir, ['checkout', '-b', 'feature']);
    // Same line number, different text in each commit - so which revision the
    // route reads is visible in the response rather than inferred.
    fs.writeFileSync(path.join(repoDir, 'total.ts'), 'one\nin first commit\nthree\n');
    runGit(repoDir, ['add', 'total.ts']);
    runGit(repoDir, ['commit', '-m', 'feature v1']);
    firstCommit = runGit(repoDir, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(repoDir, 'total.ts'), 'one\nin second commit\nthree\n');
    runGit(repoDir, ['add', 'total.ts']);
    runGit(repoDir, ['commit', '-m', 'feature v2']);
    headCommit = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function makePR(title: string): string {
    return createPR(repoDir, title, 'main', 'feature', baseCommit, headCommit, 'diff');
  }

  test('reads the file at the requested commit, not the PR head', async () => {
    const uuid = makePR('context at an older commit');
    const res = await contextRoute(
      contextReq(uuid, `?file=total.ts&start=1&end=3&commit=${firstCommit}`) as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).lines).toEqual(['one', 'in first commit', 'three']);
  });

  test('falls back to the PR head when no commit is given', async () => {
    const uuid = makePR('context with no commit');
    const res = await contextRoute(
      contextReq(uuid, '?file=total.ts&start=1&end=3') as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).lines).toEqual(['one', 'in second commit', 'three']);
  });

  // The working tree holds the second commit's text, so falling back to it
  // here would answer with content the requested commit never had.
  test('404s rather than reading the working tree for a file absent from the requested commit', async () => {
    const uuid = makePR('context for a missing file');
    const res = await contextRoute(
      contextReq(uuid, `?file=total.ts&start=1&end=3&commit=${baseCommit}`) as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('File not found in commit');
  });

  // A PR can be created from uncommitted work, so the cumulative view still
  // needs the working tree for files no commit contains yet.
  test('still reads the working tree for the head default', async () => {
    fs.writeFileSync(path.join(repoDir, 'uncommitted.ts'), 'never committed\n');
    const uuid = makePR('context for uncommitted work');
    const res = await contextRoute(
      contextReq(uuid, '?file=uncommitted.ts&start=1&end=1') as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).lines).toEqual(['never committed']);
  });

  // The client bounds expand-down on totalLines, so a final newline must not
  // read as one extra, empty line past the end of the file.
  test('does not count the final newline as an extra line', async () => {
    const uuid = makePR('context line count');
    const res = await contextRoute(
      contextReq(uuid, `?file=total.ts&start=1&end=50&commit=${firstCommit}`) as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.totalLines).toBe(3);
    expect(json.lines).toEqual(['one', 'in first commit', 'three']);
  });

  test('handles a path containing spaces and shell metacharacters', async () => {
    const trickyPath = 'a file; echo pwned.ts';
    fs.writeFileSync(path.join(repoDir, trickyPath), 'harmless\n');
    runGit(repoDir, ['add', trickyPath]);
    runGit(repoDir, ['commit', '-m', 'tricky path']);
    const trickyCommit = runGit(repoDir, ['rev-parse', 'HEAD']);

    const uuid = makePR('context for a tricky path');
    const res = await contextRoute(
      contextReq(
        uuid,
        `?file=${encodeURIComponent(trickyPath)}&start=1&end=1&commit=${trickyCommit}`,
      ) as never,
      routeParams(uuid),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).lines).toEqual(['harmless']);
  });
});

// A commit message is its own reviewable unit: signing off on the wording and
// signing off on the diff are separate acts, and only both together make the
// commit "reviewed" (what the commit selector paints green).
describe('reviewed commit message marks', () => {
  let repoDir: string;
  let baseCommit: string;
  let headCommit: string;

  function getReq(id: string): Request {
    return new Request(`http://test/api/prs/${id}`);
  }

  function deleteReq(id: string, query: string): Request {
    return new Request(`http://test/api/prs/${id}${query}`, { method: 'DELETE' });
  }

  function makePR(title: string): string {
    return createPR(repoDir, title, 'main', 'feature', baseCommit, headCommit, 'diff');
  }

  async function prJson(uuid: string) {
    const res = await prGetRoute(getReq(uuid) as never, routeParams(uuid));
    expect(res.status).toBe(200);
    return res.json();
  }

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-api-msg-repo-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base commit']);
    runGit(repoDir, ['branch', '-M', 'main']);
    baseCommit = runGit(repoDir, ['rev-parse', 'HEAD']);

    runGit(repoDir, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'first\n');
    runGit(repoDir, ['add', 'feature.txt']);
    runGit(repoDir, ['commit', '-m', 'feature v1']);
    headCommit = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('marking the message alone leaves the commit itself unreviewed', async () => {
    const uuid = makePR('message only');

    const res = await reviewedMessageRoute(
      postReq(uuid, { commitSha: headCommit }) as never,
      routeParams(uuid),
    );
    expect(res.status).toBe(200);

    const json = await prJson(uuid);
    expect(json.reviewedMessages).toEqual([
      { commit_sha: headCommit, marked_at: expect.any(String), current: true },
    ]);
    // The diff is still unread, so nothing has turned green.
    expect(json.reviewedFiles).toEqual([]);
    expect(json.reviewedCommits).toEqual([]);
  });

  test('marking every file but not the message also leaves it unreviewed', async () => {
    const uuid = makePR('files only');

    await reviewedFileRoute(
      postReq(uuid, { filePath: 'feature.txt', commitSha: headCommit }) as never,
      routeParams(uuid),
    );

    const json = await prJson(uuid);
    expect(json.reviewedMessages).toEqual([]);
    expect(json.reviewedCommits).toEqual([]);
  });

  test('message plus every file adds up to a reviewed commit', async () => {
    const uuid = makePR('both halves');

    await reviewedFileRoute(
      postReq(uuid, { filePath: 'feature.txt', commitSha: headCommit }) as never,
      routeParams(uuid),
    );
    await reviewedMessageRoute(
      postReq(uuid, { commitSha: headCommit }) as never,
      routeParams(uuid),
    );

    expect((await prJson(uuid)).reviewedCommits).toEqual([headCommit]);
  });

  test('the bulk "mark commit reviewed" route covers the message too', async () => {
    const uuid = makePR('bulk mark');

    const res = await reviewedCommitRoute(
      postReq(uuid, { commitSha: headCommit }) as never,
      routeParams(uuid),
    );
    expect(res.status).toBe(200);

    const json = await prJson(uuid);
    expect(json.reviewedMessages.map((m: { commit_sha: string }) => m.commit_sha)).toEqual([
      headCommit,
    ]);
    expect(json.reviewedCommits).toEqual([headCommit]);
  });

  test('unmarking the whole commit drops the message mark with the file ones', async () => {
    const uuid = makePR('bulk unmark');
    await reviewedCommitRoute(postReq(uuid, { commitSha: headCommit }) as never, routeParams(uuid));

    const res = await reviewedCommitDeleteRoute(
      deleteReq(uuid, `?commit=${headCommit}`) as never,
      routeParams(uuid),
    );
    expect(res.status).toBe(200);

    const json = await prJson(uuid);
    expect(json.reviewedMessages).toEqual([]);
    expect(json.reviewedFiles).toEqual([]);
  });

  test('unmarking just the message leaves the file marks alone', async () => {
    const uuid = makePR('message unmark');
    await reviewedCommitRoute(postReq(uuid, { commitSha: headCommit }) as never, routeParams(uuid));

    const res = await reviewedMessageDeleteRoute(
      deleteReq(uuid, `?commit=${headCommit}`) as never,
      routeParams(uuid),
    );
    expect(res.status).toBe(200);

    const json = await prJson(uuid);
    expect(json.reviewedMessages).toEqual([]);
    expect(json.reviewedFiles).toHaveLength(1);
    expect(json.reviewedCommits).toEqual([]);
  });

  // The stored hash is of the message text, so a reword invalidates the mark
  // the same way an edit invalidates a file's - stood in for here by a mark
  // whose hash simply doesn't match what the commit says now.
  test('a mark whose message text no longer matches comes back stale', async () => {
    const uuid = makePR('reworded');
    setReviewedCommitMessage(uuid, headCommit, 'hash-of-some-older-wording');

    const json = await prJson(uuid);
    expect(json.reviewedMessages).toEqual([
      { commit_sha: headCommit, marked_at: expect.any(String), current: false },
    ]);
    expect(json.reviewedCommits).toEqual([]);
  });

  test('rejects a commit that is not part of the PR', async () => {
    const uuid = makePR('unknown commit');
    const res = await reviewedMessageRoute(
      postReq(uuid, { commitSha: '3333333333333333333333333333333333333333' }) as never,
      routeParams(uuid),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown commit for this PR');
  });
});

describe('GET /api/prs counts', () => {
  let repoDir: string;
  let baseCommit: string;
  let headCommit: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-api-counts-'));
    runGit(repoDir, ['init']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(repoDir, ['add', 'base.txt']);
    runGit(repoDir, ['commit', '-m', 'base']);
    baseCommit = runGit(repoDir, ['rev-parse', 'HEAD']);
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(repoDir, `f${n}.txt`), `${n}\n`);
      runGit(repoDir, ['add', '.']);
      runGit(repoDir, ['commit', '-m', `feature ${n}`]);
    }
    headCommit = runGit(repoDir, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  async function listed(repo: string, uuid: string) {
    const res = await listPRsRoute(
      new Request(`http://test/api/prs?repo=${encodeURIComponent(repo)}`) as never,
    );
    return (await res.json()).prs.find((pr: { uuid: string }) => pr.uuid === uuid);
  }

  test('reports the commit count and only unresolved comments', async () => {
    const uuid = createPR(repoDir, 'counts', 'main', 'f', baseCommit, headCommit, 'd');
    addComment(uuid, 'f1.txt', 1, 'open one');
    addComment(uuid, 'f2.txt', 1, 'open two');
    const done = addComment(uuid, 'f2.txt', 1, 'resolved');
    resolveComment(done, true);

    const pr = await listed(repoDir, uuid);
    expect(pr.commit_count).toBe(2);
    expect(pr.unresolved_count).toBe(2);
  });

  test('commit_count is null when the checkout is gone, rather than failing the list', async () => {
    const uuid = createPR('/gone/for/counts', 'gone', 'main', 'f', 'a', 'b', 'd');

    const pr = await listed('/gone/for/counts', uuid);
    expect(pr.commit_count).toBeNull();
    expect(pr.unresolved_count).toBe(0);
  });
});
