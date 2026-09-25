import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';

import { planAutosquash, squashMessages, type AutosquashKind } from './autosquash';

const FIELD_SEP = '\x1f';

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  body: string;
  author: string;
  date: string;
}

interface GitResult {
  success: boolean;
  message: string;
}

/**
 * Translate a host repo path to its location inside the web server's
 * process when running in the Docker container bundled with this project
 * (docker-compose.yml bind-mounts the host's home directory to
 * HOST_PATH_PREFIX). Outside Docker (HOST_PATH_PREFIX unset), returns the
 * path unchanged.
 */
export function resolveRepoPath(repoPath: string): string {
  const hostPrefix = process.env.HOST_PATH_PREFIX;
  if (hostPrefix && repoPath.startsWith('/Users/')) {
    const parts = repoPath.split('/');
    const userPath = parts.slice(3).join('/'); // Skip /Users/<username>
    return path.join(hostPrefix, userPath);
  }
  return repoPath;
}

/**
 * Whether a PR's recorded repo path is still somewhere git can run.
 *
 * A PR outlives its checkout: one created inside a throwaway worktree (or in
 * a clone that was since moved or deleted) keeps a repo_path pointing at a
 * directory that no longer exists. Spawning git with a missing `cwd` fails as
 * a bare `spawnSync git ENOENT` - which reads as "git isn't installed" but
 * actually means "that directory is gone" - so callers check this first and
 * degrade to the stored diff instead of putting the PR permanently out of
 * reach behind a 500.
 *
 * Checks for `.git` as well as the directory itself: a leftover empty
 * worktree directory is just as unusable as a missing one, and `.git` is a
 * file (not a directory) inside a worktree, so a plain existence check covers
 * both layouts.
 */
export function isRepoAvailable(repoPath: string): boolean {
  const resolved = resolveRepoPath(repoPath);
  try {
    return fs.statSync(resolved).isDirectory() && fs.existsSync(path.join(resolved, '.git'));
  } catch {
    // statSync throws (ENOENT/EACCES) rather than returning - either way git
    // can't run there.
    return false;
  }
}

/**
 * Count the commits in `baseCommit..headCommit` - the same range listCommits
 * walks, without reading every commit's message just to take a length.
 */
export function countCommits(repoPath: string, baseCommit: string, headCommit: string): number {
  const output = execFileSync('git', ['rev-list', '--count', `${baseCommit}..${headCommit}`], {
    cwd: resolveRepoPath(repoPath),
    encoding: 'utf-8',
  });
  return parseInt(output.trim(), 10);
}

/**
 * List the commits in `baseCommit..headCommit`, oldest-first (`--reverse`)
 * so callers can render/step through them in the order they were authored.
 */
export function listCommits(
  repoPath: string,
  baseCommit: string,
  headCommit: string,
): CommitInfo[] {
  const cwd = resolveRepoPath(repoPath);
  const output = execFileSync(
    'git',
    [
      'log',
      // NUL-terminates each commit's record instead of the default blank
      // line, so records split unambiguously even though %b (body) may
      // itself contain blank lines/newlines - a plain '\n' split (safe when
      // the format was subject-only) would otherwise fragment a single
      // commit's body across multiple "records". A literal NUL can't be
      // embedded in an argv string (Node/execve both reject it), so this
      // relies on git's own -z flag to emit it in the output instead.
      '-z',
      '--reverse',
      `--format=%H${FIELD_SEP}%h${FIELD_SEP}%s${FIELD_SEP}%b${FIELD_SEP}%an${FIELD_SEP}%aI`,
      `${baseCommit}..${headCommit}`,
    ],
    { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
  );

  return output
    .split('\0')
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, shortSha, message, body, author, date] = record.split(FIELD_SEP);
      return { sha, shortSha, message, body, author, date };
    });
}

export function getCommitDiff(repoPath: string, sha: string): string {
  const cwd = resolveRepoPath(repoPath);
  // "sha^..sha" diffs against the first parent even for a merge commit,
  // so this doesn't need special-casing for merge commits in the PR range.
  return execFileSync('git', ['diff', '--no-color', `${sha}^..${sha}`], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Diff a PR's whole range, `baseRef...headRef` (three-dot: changes on the head
 * branch since it diverged from base). This mirrors the CLI's `update` command
 * (git_ops.py get_diff) exactly so a web-triggered sync produces the same diff
 * snapshot the CLI would.
 */
export function getRefDiff(repoPath: string, baseRef: string, headRef: string): string {
  const cwd = resolveRepoPath(repoPath);
  return execFileSync('git', ['diff', '--no-color', `${baseRef}...${headRef}`], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** Resolve a ref (branch/tag/sha) to its full commit SHA. */
export function resolveRefSha(repoPath: string, ref: string): string {
  const cwd = resolveRepoPath(repoPath);
  return execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd, encoding: 'utf-8' }).trim();
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}/;

export function blameCommit(
  repoPath: string,
  headCommit: string,
  filePath: string,
  line: number,
): string | null {
  const cwd = resolveRepoPath(repoPath);
  try {
    const output = execFileSync(
      'git',
      ['blame', '--porcelain', '-L', `${line},${line}`, headCommit, '--', filePath],
      { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    const match = output.match(FULL_SHA_PATTERN);
    return match ? match[0] : null;
  } catch {
    // File not found at this commit, invalid line number, etc. - the caller
    // treats a null result as "couldn't attribute this line to a commit."
    return null;
  }
}

/**
 * The git blob hash of a file's content as of a specific commit/ref, or null
 * if the file doesn't exist there (deleted, not yet added, or renamed away).
 * Content-addressed, so this is a fingerprint of what's actually in the file
 * - it survives a rebase/amend that rewrites the commit SHA without touching
 * this file's content, but changes the moment the content itself does. Used
 * to detect whether a "mark reviewed" flag is still valid (see the
 * reviewed-files API route) without needing to re-read/diff the file.
 */
export function getBlobHash(repoPath: string, sha: string, filePath: string): string | null {
  const cwd = resolveRepoPath(repoPath);
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${sha}:${filePath}`], {
      cwd,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * A commit's full message (subject plus body, `%B`), or null if the commit
 * doesn't resolve in this repo. Trailing whitespace is stripped because git
 * appends its own newline to the formatted output, which would otherwise make
 * the hash below depend on git's formatting rather than on the message.
 */
export function getCommitMessage(repoPath: string, sha: string): string | null {
  const cwd = resolveRepoPath(repoPath);
  try {
    return execFileSync('git', ['log', '-1', '--format=%B', sha], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    }).trimEnd();
  } catch {
    return null;
  }
}

/**
 * A fingerprint of a commit's message text, playing exactly the role
 * getBlobHash plays for a file: it's what a "message reviewed" mark stores,
 * so the mark survives a rebase that only re-SHAs the commit and goes stale
 * the moment the wording actually changes. Not the commit SHA itself, which
 * also moves when the tree, parent or author date change - none of which the
 * reviewer was looking at when they approved the message.
 */
export function getCommitMessageHash(repoPath: string, sha: string): string | null {
  const message = getCommitMessage(repoPath, sha);
  if (message === null) return null;
  return createHash('sha1').update(message, 'utf-8').digest('hex');
}

/** Read a file's content as of a specific commit (`git show sha:path`). */
export function getFileAtCommit(repoPath: string, sha: string, filePath: string): string | null {
  const cwd = resolveRepoPath(repoPath);
  try {
    return execFileSync('git', ['show', `${sha}:${filePath}`], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    // The file doesn't exist at this commit (added later, deleted, renamed,
    // or the commit itself no longer exists) - null means "nothing to anchor
    // against here," same convention as blameCommit.
    return null;
  }
}

interface PatchIdEntry {
  sha: string;
  patchId: string;
}

/**
 * `git log -p <range> | git patch-id --stable`, piped through Node instead of
 * a shell (execFileSync's `input` option feeds the first command's stdout as
 * the second command's stdin) so no shell interpretation of `range` is
 * needed. Each output line is `<patch-id> <commit-sha>` - patch-id hashes a
 * commit's diff content only, so it survives being replayed onto a different
 * base (a pure rebase), unlike the commit's own SHA.
 */
function computePatchIdEntries(cwd: string, range: string): PatchIdEntry[] {
  let log: string;
  try {
    log = execFileSync('git', ['log', '-p', '--no-color', '--reverse', range], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  if (!log.trim()) return [];

  const output = execFileSync('git', ['patch-id', '--stable'], {
    cwd,
    encoding: 'utf-8',
    input: log,
    maxBuffer: 50 * 1024 * 1024,
  });

  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line): PatchIdEntry | null => {
      const [patchId, sha] = line.split(' ');
      return patchId && sha ? { sha, patchId } : null;
    })
    .filter((entry): entry is PatchIdEntry => entry !== null);
}

interface MessageEntry {
  sha: string;
  message: string;
}

function computeMessageEntries(cwd: string, range: string): MessageEntry[] {
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['log', '-z', '--reverse', `--format=%H${FIELD_SEP}%s${FIELD_SEP}%b`, range],
      { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    return [];
  }
  return output
    .split('\0')
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, subject, body] = record.split(FIELD_SEP);
      return { sha, message: `${subject}\n${body}` };
    });
}

export interface CommitCorrespondence {
  /** oldSha -> newSha, for every old commit a matching new commit was found for. */
  matched: Map<string, string>;
  /** oldSha, for every old commit nothing could be matched to (dropped, squashed
   * away, or a split this couldn't safely attribute to one side). */
  unmatched: string[];
}

/**
 * Match commits from an old `oldBase..oldHead` range to their counterparts in
 * a new `newBase..newHead` range after a rebase/amend/force-push, so callers
 * can relocate anything keyed to the old SHAs (comments, `commit_relocations`
 * rows). Two-tier, in order, greedy and deterministic (oldest-first, per each
 * range's own commit order) - no positional/index-based fallback, so a commit
 * split into several (or dropped outright) is left unmatched rather than
 * guessed at:
 *
 * 1. Patch-id: survives a pure rebase/reorder (diff content unchanged).
 * 2. Commit message: catches an amend that changed the diff but kept the
 *    message.
 *
 * `oldShas` (from `listCommits`, not from the patch-id/message passes) is the
 * ground truth for which old commits need an answer - if patch-id/log
 * computation fails outright for the old range (e.g. its objects were
 * garbage-collected before this ran), every old commit still comes back
 * unmatched rather than silently vanishing from both `matched` and
 * `unmatched`.
 */
export function computeCommitCorrespondence(
  repoPath: string,
  oldBase: string,
  oldHead: string,
  newBase: string,
  newHead: string,
): CommitCorrespondence {
  const cwd = resolveRepoPath(repoPath);

  let oldShas: string[];
  try {
    oldShas = listCommits(repoPath, oldBase, oldHead).map((c) => c.sha);
  } catch {
    oldShas = [];
  }
  if (oldShas.length === 0) return { matched: new Map(), unmatched: [] };

  const oldPatchIdBySha = new Map(
    computePatchIdEntries(cwd, `${oldBase}..${oldHead}`).map((e) => [e.sha, e.patchId]),
  );
  const newByPatchId = new Map<string, string[]>();
  for (const { sha, patchId } of computePatchIdEntries(cwd, `${newBase}..${newHead}`)) {
    const list = newByPatchId.get(patchId);
    if (list) list.push(sha);
    else newByPatchId.set(patchId, [sha]);
  }

  const matched = new Map<string, string>();
  const claimedNewShas = new Set<string>();
  const afterPatchId: string[] = [];

  for (const sha of oldShas) {
    const patchId = oldPatchIdBySha.get(sha);
    const candidates = patchId ? newByPatchId.get(patchId) : undefined;
    const next = candidates?.shift();
    if (next) {
      matched.set(sha, next);
      claimedNewShas.add(next);
    } else {
      afterPatchId.push(sha);
    }
  }

  if (afterPatchId.length === 0) return { matched, unmatched: [] };

  // Message fallback for anything patch-id couldn't match - join on identical
  // subject+body among commits not already claimed on the new side.
  const oldMessageBySha = new Map(
    computeMessageEntries(cwd, `${oldBase}..${oldHead}`).map((e) => [e.sha, e.message]),
  );
  const newByMessage = new Map<string, string[]>();
  for (const { sha, message } of computeMessageEntries(cwd, `${newBase}..${newHead}`)) {
    if (claimedNewShas.has(sha)) continue;
    const list = newByMessage.get(message);
    if (list) list.push(sha);
    else newByMessage.set(message, [sha]);
  }

  const unmatched: string[] = [];
  for (const sha of afterPatchId) {
    const message = oldMessageBySha.get(sha);
    const candidates = message ? newByMessage.get(message) : undefined;
    const next = candidates?.shift();
    if (next) {
      matched.set(sha, next);
      claimedNewShas.add(next);
    } else {
      unmatched.push(sha);
    }
  }

  return { matched, unmatched };
}

export interface AbsorbedCommit {
  sha: string;
  shortSha: string;
  message: string;
  kind: AutosquashKind;
}

/** One commit of the branch as `rebase -i --autosquash` would leave it. */
export interface SquashedCommit extends CommitInfo {
  /** The PR commit this one was built from - the fixups' target. */
  originalSha: string;
  /** The fixup!/amend!/squash! commits folded into it, in the order applied. */
  absorbed: AbsorbedCommit[];
  /** False when the commit came through untouched and `sha` is still the
   * PR's own commit; true once folding, or rebasing onto a folded commit,
   * gave it a new one that exists only for this preview. */
  rewritten: boolean;
  /** See SquashedMessage.needsEdit. */
  messageNeedsEdit: boolean;
  /** See AutosquashGroup.unmatchedMarker. */
  unmatchedMarker: boolean;
}

export interface AutosquashConflict {
  /** The commit that didn't apply cleanly... */
  sha: string;
  shortSha: string;
  message: string;
  /** ...and the commit it was being folded into (itself, for a plain commit
   * being rebased after an earlier fold). */
  targetSha: string;
  files: string[];
}

export interface AutosquashResult {
  /** Stops short of the commit that conflicted, when one did. */
  commits: SquashedCommit[];
  conflict: AutosquashConflict | null;
  /** Whether the last squashed commit has the same tree as the PR's head -
   * i.e. squashing changed only how the history is split up, not the end
   * result. Always false when replay stopped on a conflict. */
  matchesHead: boolean;
  /** The PR commit shas this was computed from, so a client can tell once
   * the branch has moved on without it. */
  sourceShas: string[];
}

class CherryPickConflict extends Error {
  constructor(readonly files: string[]) {
    super('cherry-pick conflict');
  }
}

/**
 * The tree `commit` leaves when cherry-picked onto `onto`, via
 * `git merge-tree --write-tree` (git 2.40+ for --merge-base): a real
 * three-way merge that never touches the index or working tree, so the
 * preview can't disturb a checkout someone is working in. It only writes the
 * resulting tree/blob objects into the object store, unreferenced.
 */
function cherryPickTree(cwd: string, onto: string, commit: string): string {
  try {
    const output = execFileSync(
      'git',
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        `--merge-base=${commit}^`,
        onto,
        commit,
      ],
      { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    return output.split('\n')[0].trim();
  } catch (error: unknown) {
    // Exit status 1 is merge-tree's "merged, with conflicts": the tree oid
    // on the first line, then one conflicted path per line up to a blank one.
    const failed = error as { status?: number; stdout?: string };
    if (failed.status === 1 && typeof failed.stdout === 'string') {
      const lines = failed.stdout.split('\n');
      const end = lines.indexOf('', 1);
      const files = lines.slice(1, end < 0 ? undefined : end).filter(Boolean);
      throw new CherryPickConflict([...new Set(files)]);
    }
    throw error;
  }
}

interface CommitIdentity {
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
}

function getCommitIdentity(cwd: string, sha: string): CommitIdentity {
  const output = execFileSync(
    'git',
    [
      'show',
      '-s',
      '--date=raw',
      `--format=%an${FIELD_SEP}%ae${FIELD_SEP}%ad${FIELD_SEP}%cn${FIELD_SEP}%ce${FIELD_SEP}%cd`,
      sha,
    ],
    { cwd, encoding: 'utf-8' },
  );
  const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = output
    .trimEnd()
    .split(FIELD_SEP);
  return { authorName, authorEmail, authorDate, committerName, committerEmail, committerDate };
}

/**
 * `git commit-tree` with every identity field pinned to `identity`, so the
 * same inputs always produce the same sha: a preview commit's URL survives a
 * server restart, and building one needs no user.name/user.email configured.
 * --no-gpg-sign because commit-tree honours commit.gpgSign, and a signing
 * prompt (or a missing key) has no business in a read-only preview.
 */
function commitTree(
  cwd: string,
  tree: string,
  parent: string,
  message: string,
  identity: CommitIdentity,
): string {
  return execFileSync('git', ['commit-tree', '--no-gpg-sign', '-p', parent, '-F', '-', tree], {
    cwd,
    encoding: 'utf-8',
    input: `${message}\n`,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: identity.authorName,
      GIT_AUTHOR_EMAIL: identity.authorEmail,
      GIT_AUTHOR_DATE: identity.authorDate,
      GIT_COMMITTER_NAME: identity.committerName,
      GIT_COMMITTER_EMAIL: identity.committerEmail,
      GIT_COMMITTER_DATE: identity.committerDate,
    },
  }).trim();
}

function tryResolveCommit(cwd: string, name: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], {
      cwd,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The PR's commits as `git rebase -i --autosquash --keep-base` would leave
 * them, without running a rebase: planAutosquash decides the grouping, then
 * each group is replayed with cherryPickTree/commitTree on top of the
 * previous one, starting from the branch's merge base (`--keep-base`, so the
 * preview shows the effect of squashing alone, not of catching up with the
 * base branch too).
 *
 * Commits are reused as-is until the first one that actually changes, just
 * as a real rebase fast-forwards over them - so those keep their real shas,
 * and everything keyed to them (comments, reviewed marks) still applies.
 * Everything from there on is a new, unreferenced commit that exists only in
 * the object store until git gc prunes it; being deterministic, it's simply
 * rebuilt with the same sha on the next request if that has happened.
 *
 * Throws for a range containing merge commits (autosquash would linearize
 * them, which is its own change to review) and for a git too old for
 * merge-tree --merge-base.
 */
export function autosquashCommits(
  repoPath: string,
  baseCommit: string,
  headCommit: string,
): AutosquashResult {
  const cwd = resolveRepoPath(repoPath);
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

  const merges = git(['rev-list', '--min-parents=2', '--count', `${baseCommit}..${headCommit}`]);
  if (parseInt(merges, 10) > 0) {
    throw new Error("Can't preview autosquash for a branch containing merge commits");
  }

  const commits = listCommits(repoPath, baseCommit, headCommit);
  const groups = planAutosquash(commits, (name) => tryResolveCommit(cwd, name));
  const sourceShas = commits.map((c) => c.sha);

  let tip = git(['merge-base', baseCommit, headCommit]);
  const squashed: SquashedCommit[] = [];

  for (const { target, steps, unmatchedMarker } of groups) {
    const absorbed = steps.map(({ commit, kind }) => ({
      sha: commit.sha,
      shortSha: commit.shortSha,
      message: commit.message,
      kind,
    }));

    if (steps.length === 0 && git(['rev-parse', `${target.sha}^`]) === tip) {
      squashed.push({
        ...target,
        originalSha: target.sha,
        absorbed,
        rewritten: false,
        messageNeedsEdit: false,
        unmatchedMarker,
      });
      tip = target.sha;
      continue;
    }

    const identity = getCommitIdentity(cwd, target.sha);
    const targetMessage = getCommitMessage(repoPath, target.sha) ?? target.message;
    let applying: CommitInfo = target;
    try {
      // Each step is cherry-picked onto the fold so far, which has to be a
      // commit for merge-tree - these intermediates are never shown.
      let working = commitTree(
        cwd,
        cherryPickTree(cwd, tip, target.sha),
        tip,
        targetMessage,
        identity,
      );
      for (const step of steps) {
        applying = step.commit;
        working = commitTree(
          cwd,
          cherryPickTree(cwd, working, step.commit.sha),
          tip,
          targetMessage,
          identity,
        );
      }

      const { message, needsEdit } = squashMessages(
        targetMessage,
        steps.map(({ commit, kind }) => ({
          kind,
          message: getCommitMessage(repoPath, commit.sha) ?? commit.message,
        })),
      );
      const sha = commitTree(cwd, git(['rev-parse', `${working}^{tree}`]), tip, message, identity);
      const [subject, ...bodyParagraphs] = message.split('\n\n');
      squashed.push({
        sha,
        shortSha: git(['rev-parse', '--short', sha]),
        // %s folds a multi-line first paragraph onto one line; match it.
        message: subject.split('\n').join(' '),
        body: bodyParagraphs.join('\n\n'),
        author: target.author,
        date: target.date,
        originalSha: target.sha,
        absorbed,
        rewritten: true,
        messageNeedsEdit: needsEdit,
        unmatchedMarker,
      });
      tip = sha;
    } catch (error: unknown) {
      if (!(error instanceof CherryPickConflict)) throw error;
      return {
        commits: squashed,
        conflict: {
          sha: applying.sha,
          shortSha: applying.shortSha,
          message: applying.message,
          targetSha: target.sha,
          files: error.files,
        },
        matchesHead: false,
        sourceShas,
      };
    }
  }

  const matchesHead =
    git(['rev-parse', `${tip}^{tree}`]) === git(['rev-parse', `${headCommit}^{tree}`]);
  return { commits: squashed, conflict: null, matchesHead, sourceShas };
}

export function getGitUserIdentity(): { name: string | null; email: string | null } {
  return {
    name: tryGlobalGitConfig('user.name'),
    email: tryGlobalGitConfig('user.email'),
  };
}

function tryGlobalGitConfig(key: string): string | null {
  try {
    const value = execFileSync('git', ['config', '--global', '--get', key], {
      encoding: 'utf-8',
    }).trim();
    return value || null;
  } catch {
    // No git config, no HOME/.gitconfig, or git not installed - all treated
    // the same: no identity to suggest.
    return null;
  }
}

export class GitManager {
  private git: SimpleGit;
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  async getRefs() {
    const branches = await this.git.branch();
    const tags = await this.git.tag();
    return {
      branches: branches.all,
      current: branches.current,
      tags: tags.split('\n').filter(Boolean),
    };
  }

  async getCurrentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current || 'HEAD';
  }

  async getCommitSha(ref: string): Promise<string> {
    const result = await this.git.revparse([ref]);
    return result.trim();
  }

  async getDiff(base: string, head: string): Promise<string> {
    return await this.git.diff([`${base}...${head}`]);
  }

  async getFileDiff(base: string, head: string, filePath: string): Promise<string> {
    return await this.git.diff([`${base}...${head}`, '--', filePath]);
  }

  async isDirty(): Promise<boolean> {
    const status = await this.git.status();
    return !status.isClean();
  }

  async merge(headBranch: string, baseBranch: string = 'main'): Promise<GitResult> {
    try {
      // Checkout base branch
      await this.git.checkout(baseBranch);

      // Merge with no-ff
      const message = `Merge branch '${headBranch}' into ${baseBranch}`;
      await this.git.merge([headBranch, '--no-ff', '-m', message]);

      return {
        success: true,
        message: `Merged ${headBranch} into ${baseBranch}`,
      };
    } catch (error: unknown) {
      // Try to abort merge if it failed
      try {
        await this.git.merge(['--abort']);
      } catch {
        // Ignore abort errors
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        message: errorMessage,
      };
    }
  }

  async push(remote: string = 'origin', branch?: string): Promise<GitResult> {
    try {
      const targetBranch = branch || (await this.getCurrentBranch());
      await this.git.push(remote, targetBranch);
      return {
        success: true,
        message: `Pushed ${targetBranch} to ${remote}`,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        message: errorMessage,
      };
    }
  }

  async deleteBranch(branch: string, force: boolean = false): Promise<GitResult> {
    try {
      const flag = force ? '-D' : '-d';
      await this.git.branch([flag, branch]);
      return {
        success: true,
        message: `Deleted branch ${branch}`,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        message: errorMessage,
      };
    }
  }

  async applyPatch(patch: string): Promise<{ success: boolean; error?: string }> {
    const tmpFile = path.join('/tmp', `patch-${Date.now()}.diff`);
    fs.writeFileSync(tmpFile, patch);
    try {
      await this.git.raw(['apply', tmpFile]);
      return { success: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }

  async commit(message: string) {
    await this.git.add('.');
    return await this.git.commit(message);
  }

  async getCommitsBetween(
    base: string,
    head: string,
  ): Promise<
    Array<{
      sha: string;
      message: string;
      author: string;
      date: string;
    }>
  > {
    const log = await this.git.log({ from: base, to: head });
    return log.all.map((c) => ({
      sha: c.hash,
      message: c.message,
      author: c.author_name,
      date: c.date,
    }));
  }
}
