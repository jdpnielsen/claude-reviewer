import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';

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
