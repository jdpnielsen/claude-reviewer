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

import { GET as prGetRoute, PATCH } from '../app/api/prs/[id]/route';
import { POST as syncRoute } from '../app/api/prs/[id]/sync/route';
import { GET as listPRsRoute } from '../app/api/prs/route';
import {
  addComment,
  createPR,
  getPRByUuid,
  getLatestDiff,
  updatePRStatus,
  upsertCommitRelocation,
  closeDatabase,
} from '../lib/database';
import { PullRequestStatus } from '../lib/enum';

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
