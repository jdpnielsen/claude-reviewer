import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveRepoPath,
  listCommits,
  getCommitDiff,
  blameCommit,
  getGitUserIdentity,
} from '../lib/git';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
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
