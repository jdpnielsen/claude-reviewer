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
