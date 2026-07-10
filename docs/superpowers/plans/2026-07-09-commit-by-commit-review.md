# Commit-by-commit review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer browse a PR's diff one commit at a time (in addition to the existing cumulative view), with comments scoped to whichever commit they were made against, and have both the CLI and the AI auto-reviewer understand that scoping.

**Architecture:** Commits and per-commit diffs are derived live from git in the Next.js server (a new `lib/git.ts`, following the existing `git show`-in-a-route-handler pattern already used by `context/route.ts`) rather than precomputed and stored — no new tables. The only schema change is a nullable `commit_sha` column on `comments`. The AI auto-reviewer attributes each of its comments to a commit via `git blame`.

**Tech Stack:** Next.js (TypeScript) web app + Python/Click CLI sharing one SQLite database; `better-sqlite3` (TS) and `sqlite3` (Python) as DB drivers; `child_process.execFileSync` for git calls from the web server; Jest (TS) and pytest (Python) for tests.

## Global Constraints

- Every new git shell-out uses `execFileSync` with an argument array (never a template-string command) — this codebase already has an `execSync` template-string call in `context/route.ts` for an unrelated purpose, but new code introduced by this plan must not add another string-interpolated shell call.
- `commit_sha = NULL` on a comment means "scoped to the cumulative view," not "unknown." Every pre-existing comment is `NULL` and stays that way — no backfill.
- No new CLI commands or flags. The CLI only needs to *display* which commit a comment belongs to.
- Do not touch `app/api/browse/file/route.ts`'s inline path-translation logic — it's a separate, pre-existing bug (documented in the spec) and out of scope here.
- Full spec: `docs/superpowers/specs/2026-07-09-commit-by-commit-review-design.md`.

---

### Task 1: `commit_sha` column + migration (TypeScript)

**Files:**
- Modify: `lib/database.ts:22-33` (Comment interface), `lib/database.ts:189-200` (comments DDL), `lib/database.ts:265-284` (initSchema / migration), `lib/database.ts:426-454` (addComment)
- Test: `__tests__/database.test.ts`

**Interfaces:**
- Produces: `Comment.commit_sha: string | null`; `addComment(prUuid, filePath, lineNumber, content, lineType?, endLineNumber?, commitSha?: string | null): string` — new 7th param, defaults to `null`, fully backward compatible with all existing call sites.

- [ ] **Step 1: Write the failing test**

Add to the `describe("Comment Operations", ...)` block in `__tests__/database.test.ts`, right after the existing `test("deleteComment removes comment", ...)` block (before its closing `});` at line 210):

```ts
    test("addComment defaults commit_sha to null and stores it when provided", () => {
      const cumulativeUuid = addComment(prUuid, "scoped.py", 1, "cumulative comment");
      const scopedUuid = addComment(prUuid, "scoped.py", 2, "commit comment", "new", 2, "abc1234");

      const fileComments = getComments(prUuid, { filePath: "scoped.py" });
      const cumulative = fileComments.find((c) => c.uuid === cumulativeUuid);
      const scoped = fileComments.find((c) => c.uuid === scopedUuid);

      expect(cumulative?.commit_sha).toBeNull();
      expect(scoped?.commit_sha).toBe("abc1234");
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- database.test.ts -t "addComment defaults commit_sha"`
Expected: FAIL — `TypeError` or the 7-arg call fails type-checking (`ts-jest` reports "Expected 2-6 arguments, but got 7"), since `addComment` doesn't accept a 7th parameter yet and `Comment` has no `commit_sha` field.

- [ ] **Step 3: Add the column, migration, interface field, and param**

In `lib/database.ts`, update the `Comment` interface (currently lines 22-33):

```ts
export interface Comment {
  id: number;
  uuid: string;
  pr_id: number;
  file_path: string;
  line_number: number;
  end_line_number: number;
  commit_sha: string | null;
  line_type: 'old' | 'new' | 'context';
  content: string;
  resolved: boolean;
  created_at: string;
}
```

Update the comments table DDL inside `initSchema()` (currently lines 189-200):

```ts
    -- Comments table
    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        end_line_number INTEGER,
        commit_sha TEXT,
        line_type TEXT DEFAULT 'new',
        content TEXT NOT NULL,
        resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
```

Add a new migration function right after `migrateCommentsEndLine` (currently ends at line 284), and call it from `initSchema()`:

```ts
// Adds commit_sha for databases created before commit-by-commit review existed.
// NULL means "scoped to the cumulative view" - correct for every pre-existing
// comment, so unlike migrateCommentsEndLine, no backfill is needed.
function migrateCommentsCommitSha(db: Database.Database): void {
  const columns = db.pragma('table_info(comments)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'commit_sha')) {
    try {
      db.exec('ALTER TABLE comments ADD COLUMN commit_sha TEXT');
    } catch (e) {
      // A concurrent process (the Python CLI, or another reconnect) may have
      // added the column between the check above and this ALTER.
      if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
    }
  }
}
```

Find the line `migrateCommentsEndLine(db);` at the end of `initSchema()` (currently line 265) and change it to:

```ts
  migrateCommentsEndLine(db);
  migrateCommentsCommitSha(db);
```

Update `addComment()` (currently lines 426-454):

```ts
export function addComment(
  prUuid: string,
  filePath: string,
  lineNumber: number,
  content: string,
  lineType: 'old' | 'new' | 'context' = 'new',
  endLineNumber: number = lineNumber,
  commitSha: string | null = null
): string {
  const db = getDatabase();
  const commentUuid = generateUuid();

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as { id: number } | undefined;
  if (!pr) throw new Error(`PR ${prUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO comments (uuid, pr_id, file_path, line_number, end_line_number, commit_sha, line_type, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(commentUuid, pr.id, filePath, lineNumber, endLineNumber, commitSha, lineType, content);

    db.prepare(
      'UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(pr.id);
  });

  transaction();
  checkpoint();
  return commentUuid;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- database.test.ts`
Expected: PASS — all tests in the file, including the new one.

- [ ] **Step 5: Commit**

```bash
git add lib/database.ts __tests__/database.test.ts
git commit -m "feat: add commit_sha column for commit-scoped comments"
```

---

### Task 2: `commit_sha` column + migration (Python)

**Files:**
- Modify: `claude-reviewer-cli/claude_reviewer/database.py:98-110` (comments DDL), `:209-227` (init_db / migration), `:248-261` (`_row_to_comment`), `:451-486` (`add_comment`)
- Modify: `claude-reviewer-cli/claude_reviewer/models.py:39-50` (`Comment` dataclass)
- Test: `claude-reviewer-cli/tests/test_database.py`

**Interfaces:**
- Produces: `Comment.commit_sha: Optional[str]`; `add_comment(pr_uuid, file_path, line_number, content, line_type="new", end_line_number=None, commit_sha=None) -> str` — new keyword param, defaults to `None`.

- [ ] **Step 1: Write the failing test**

Add to `TestComments` in `claude-reviewer-cli/tests/test_database.py`, right after `test_add_comment` (after line 226):

```python
    def test_add_comment_stores_commit_sha(self, temp_db: Path) -> None:
        """Test that commit_sha defaults to None and can be set."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        db.add_comment(pr_uuid=uuid, file_path="scoped.py", line_number=1, content="cumulative")
        db.add_comment(
            pr_uuid=uuid,
            file_path="scoped.py",
            line_number=2,
            content="scoped",
            commit_sha="abc1234",
        )

        comments = db.get_comments(uuid, file_path="scoped.py")
        cumulative = next(c for c in comments if c.content == "cumulative")
        scoped = next(c for c in comments if c.content == "scoped")
        assert cumulative.commit_sha is None
        assert scoped.commit_sha == "abc1234"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-reviewer-cli && pytest tests/test_database.py -k test_add_comment_stores_commit_sha -v`
Expected: FAIL — `TypeError: add_comment() got an unexpected keyword argument 'commit_sha'`.

- [ ] **Step 3: Add the column, migration, dataclass field, and param**

In `claude-reviewer-cli/claude_reviewer/models.py`, update the `Comment` dataclass (currently lines 39-50):

```python
@dataclass
class Comment:
    id: int
    uuid: str
    pr_id: int
    file_path: str
    line_number: int
    end_line_number: int
    content: str
    commit_sha: Optional[str] = None
    resolved: bool = False
    line_type: str = "new"
    created_at: Optional[datetime] = None
```

In `claude-reviewer-cli/claude_reviewer/database.py`, update the comments DDL inside `SCHEMA_SQL` (currently lines 98-110):

```sql
-- Comments table
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    end_line_number INTEGER,
    commit_sha TEXT,
    line_type TEXT DEFAULT 'new',
    content TEXT NOT NULL,
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Add a new migration function right after `_migrate_comments_end_line` (currently ends at line 227), and call it from `init_db()`:

```python
def _migrate_comments_commit_sha(conn: sqlite3.Connection) -> None:
    """Add commit_sha for databases created before commit-by-commit review existed.

    NULL means "scoped to the cumulative view" - correct for every pre-existing
    comment, so unlike _migrate_comments_end_line, no backfill is needed.
    """
    columns = conn.execute("PRAGMA table_info(comments)").fetchall()
    if not any(col["name"] == "commit_sha" for col in columns):
        try:
            conn.execute("ALTER TABLE comments ADD COLUMN commit_sha TEXT")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e).lower():
                raise
```

Update `init_db()` (currently lines 209-213):

```python
def init_db(db_path: Path | None = None) -> None:
    """Initialize database schema and apply any pending migrations."""
    with get_connection(db_path) as conn:
        conn.executescript(SCHEMA_SQL)
        _migrate_comments_end_line(conn)
        _migrate_comments_commit_sha(conn)
```

Update `_row_to_comment()` (currently lines 248-261):

```python
def _row_to_comment(row: sqlite3.Row) -> Comment:
    """Convert a database row to a Comment object."""
    return Comment(
        id=row["id"],
        uuid=row["uuid"],
        pr_id=row["pr_id"],
        file_path=row["file_path"],
        line_number=row["line_number"],
        end_line_number=row["end_line_number"],
        commit_sha=row["commit_sha"],
        line_type=row["line_type"],
        content=row["content"],
        resolved=bool(row["resolved"]),
        created_at=row["created_at"],
    )
```

Update `add_comment()` (currently lines 451-486):

```python
def add_comment(
    pr_uuid: str,
    file_path: str,
    line_number: int,
    content: str,
    line_type: str = "new",
    end_line_number: int | None = None,
    commit_sha: str | None = None,
) -> str:
    """Add a comment to a PR and return its UUID."""
    comment_uuid = generate_uuid()
    resolved_end_line = end_line_number if end_line_number is not None else line_number

    with get_connection() as conn:
        pr = conn.execute(
            "SELECT id, status FROM pull_requests WHERE uuid = ?",
            (pr_uuid,),
        ).fetchone()

        if not pr:
            raise ValueError(f"PR {pr_uuid} not found")

        conn.execute(
            """
            INSERT INTO comments (uuid, pr_id, file_path, line_number, end_line_number, commit_sha, line_type, content)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (comment_uuid, pr["id"], file_path, line_number, resolved_end_line, commit_sha, line_type, content),
        )

        # Update PR timestamp
        conn.execute(
            "UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (pr["id"],),
        )

    return comment_uuid
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claude-reviewer-cli && pytest tests/test_database.py -v`
Expected: PASS — all tests in the file, including the new one.

- [ ] **Step 5: Commit**

```bash
git add claude-reviewer-cli/claude_reviewer/database.py claude-reviewer-cli/claude_reviewer/models.py claude-reviewer-cli/tests/test_database.py
git commit -m "feat: add commit_sha column for commit-scoped comments (Python)"
```

---

### Task 3: `lib/git.ts` — `resolveRepoPath` + `listCommits`

**Files:**
- Create: `lib/git.ts`
- Modify: `app/api/prs/[id]/context/route.ts:1-21` (replace inline `translatePath` with shared helper)
- Test: `__tests__/git.test.ts`

**Interfaces:**
- Produces: `resolveRepoPath(repoPath: string): string`; `CommitInfo { sha: string; shortSha: string; message: string; author: string; date: string }`; `listCommits(repoPath: string, baseCommit: string, headCommit: string): CommitInfo[]` (oldest-first).

- [ ] **Step 1: Write the failing test**

Create `__tests__/git.test.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { resolveRepoPath, listCommits } from "../lib/git";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("resolveRepoPath", () => {
  const originalPrefix = process.env.HOST_PATH_PREFIX;

  afterEach(() => {
    if (originalPrefix === undefined) {
      delete process.env.HOST_PATH_PREFIX;
    } else {
      process.env.HOST_PATH_PREFIX = originalPrefix;
    }
  });

  test("returns the path unchanged when HOST_PATH_PREFIX is not set", () => {
    delete process.env.HOST_PATH_PREFIX;
    expect(resolveRepoPath("/Users/alice/project")).toBe("/Users/alice/project");
  });

  test("translates a /Users/<user>/... path when HOST_PATH_PREFIX is set", () => {
    process.env.HOST_PATH_PREFIX = "/host-home";
    expect(resolveRepoPath("/Users/alice/project")).toBe("/host-home/project");
  });
});

describe("listCommits", () => {
  let repoDir: string;
  let baseSha: string;
  let headSha: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reviewer-git-test-"));
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);

    fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n");
    runGit(repoDir, ["add", "base.txt"]);
    runGit(repoDir, ["commit", "-m", "base commit"]);
    baseSha = runGit(repoDir, ["rev-parse", "HEAD"]);

    fs.writeFileSync(path.join(repoDir, "a.txt"), "content a\n");
    runGit(repoDir, ["add", "a.txt"]);
    runGit(repoDir, ["commit", "-m", "add a"]);

    fs.writeFileSync(path.join(repoDir, "b.txt"), "content b\n");
    runGit(repoDir, ["add", "b.txt"]);
    runGit(repoDir, ["commit", "-m", "add b"]);
    headSha = runGit(repoDir, ["rev-parse", "HEAD"]);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test("returns commits between base and head, oldest first", () => {
    const commits = listCommits(repoDir, baseSha, headSha);

    expect(commits).toHaveLength(2);
    expect(commits[0].message).toBe("add a");
    expect(commits[1].message).toBe("add b");
    expect(commits[0].shortSha).toHaveLength(7);
    expect(commits[1].sha).toBe(headSha);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- git.test.ts`
Expected: FAIL — `Cannot find module '../lib/git'`.

- [ ] **Step 3: Create `lib/git.ts`**

```ts
import { execFileSync } from 'child_process';
import path from 'path';

const FIELD_SEP = '\x1f';

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
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

export function listCommits(repoPath: string, baseCommit: string, headCommit: string): CommitInfo[] {
  const cwd = resolveRepoPath(repoPath);
  const output = execFileSync(
    'git',
    [
      'log',
      '--reverse',
      `--format=%H${FIELD_SEP}%h${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%aI`,
      `${baseCommit}..${headCommit}`,
    ],
    { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
  );

  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, shortSha, message, author, date] = line.split(FIELD_SEP);
      return { sha, shortSha, message, author, date };
    });
}
```

Then, in `app/api/prs/[id]/context/route.ts`, replace the inline `translatePath` (currently lines 11-21) and its usage (currently line 43) to use the shared helper instead of duplicating the logic a third time:

Replace:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getPRByUuid } from '@/lib/database';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Translate host paths to Docker paths if running in container
function translatePath(hostPath: string): string {
  const hostPrefix = process.env.HOST_PATH_PREFIX;
  if (hostPrefix && hostPath.startsWith('/Users/')) {
    // Extract the path after /Users/username/
    const parts = hostPath.split('/');
    const userPath = parts.slice(3).join('/'); // Skip /Users/username
    return path.join(hostPrefix, userPath);
  }
  return hostPath;
}
```

with:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getPRByUuid } from '@/lib/database';
import { resolveRepoPath } from '@/lib/git';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface RouteParams {
  params: Promise<{ id: string }>;
}
```

And update its single call site (currently `const repoPath = translatePath(pr.repo_path);` at line 43) to:
```ts
    const repoPath = resolveRepoPath(pr.repo_path);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- git.test.ts`
Expected: PASS.

Then run: `npx tsc --noEmit`
Expected: no errors (confirms `context/route.ts` still compiles after the import swap).

- [ ] **Step 5: Commit**

```bash
git add lib/git.ts __tests__/git.test.ts app/api/prs/[id]/context/route.ts
git commit -m "feat: add lib/git.ts with resolveRepoPath and listCommits"
```

---

### Task 4: `lib/git.ts` — `getCommitDiff`

**Files:**
- Modify: `lib/git.ts`
- Test: `__tests__/git.test.ts`

**Interfaces:**
- Consumes: `resolveRepoPath` (Task 3, same file).
- Produces: `getCommitDiff(repoPath: string, sha: string): string`.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/git.test.ts`, after the `describe("listCommits", ...)` block:

```ts
describe("getCommitDiff", () => {
  let repoDir: string;
  let addBSha: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reviewer-git-test-"));
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);

    fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n");
    runGit(repoDir, ["add", "base.txt"]);
    runGit(repoDir, ["commit", "-m", "base commit"]);

    fs.writeFileSync(path.join(repoDir, "a.txt"), "content a\n");
    runGit(repoDir, ["add", "a.txt"]);
    runGit(repoDir, ["commit", "-m", "add a"]);

    fs.writeFileSync(path.join(repoDir, "b.txt"), "content b\n");
    runGit(repoDir, ["add", "b.txt"]);
    runGit(repoDir, ["commit", "-m", "add b"]);
    addBSha = runGit(repoDir, ["rev-parse", "HEAD"]);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test("returns only the diff introduced by that single commit", () => {
    const diff = getCommitDiff(repoDir, addBSha);

    expect(diff).toContain("b.txt");
    expect(diff).not.toContain("a.txt");
  });
});
```

Update the import line at the top of `__tests__/git.test.ts`:
```ts
import { resolveRepoPath, listCommits, getCommitDiff } from "../lib/git";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- git.test.ts`
Expected: FAIL — `getCommitDiff is not a function`.

- [ ] **Step 3: Add `getCommitDiff` to `lib/git.ts`**

Append to `lib/git.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/git.ts __tests__/git.test.ts
git commit -m "feat: add getCommitDiff to lib/git.ts"
```

---

### Task 5: `lib/git.ts` — `blameCommit`

**Files:**
- Modify: `lib/git.ts`
- Test: `__tests__/git.test.ts`

**Interfaces:**
- Consumes: `resolveRepoPath` (Task 3, same file).
- Produces: `blameCommit(repoPath: string, headCommit: string, filePath: string, line: number): string | null`.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/git.test.ts`, after the `describe("getCommitDiff", ...)` block:

```ts
describe("blameCommit", () => {
  let repoDir: string;
  let addASha: string;
  let headSha: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reviewer-git-test-"));
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);

    fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n");
    runGit(repoDir, ["add", "base.txt"]);
    runGit(repoDir, ["commit", "-m", "base commit"]);

    fs.writeFileSync(path.join(repoDir, "a.txt"), "line one\nline two\n");
    runGit(repoDir, ["add", "a.txt"]);
    runGit(repoDir, ["commit", "-m", "add a"]);
    addASha = runGit(repoDir, ["rev-parse", "HEAD"]);

    fs.writeFileSync(path.join(repoDir, "b.txt"), "content b\n");
    runGit(repoDir, ["add", "b.txt"]);
    runGit(repoDir, ["commit", "-m", "add b"]);
    headSha = runGit(repoDir, ["rev-parse", "HEAD"]);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test("finds the commit that last touched a line", () => {
    const sha = blameCommit(repoDir, headSha, "a.txt", 1);
    expect(sha).toBe(addASha);
  });

  test("returns null for a file that doesn't exist", () => {
    const sha = blameCommit(repoDir, headSha, "nope.txt", 1);
    expect(sha).toBeNull();
  });
});
```

Update the import line at the top of `__tests__/git.test.ts`:
```ts
import { resolveRepoPath, listCommits, getCommitDiff, blameCommit } from "../lib/git";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- git.test.ts`
Expected: FAIL — `blameCommit is not a function`.

- [ ] **Step 3: Add `blameCommit` to `lib/git.ts`**

Append to `lib/git.ts`:

```ts
const FULL_SHA_PATTERN = /^[0-9a-f]{40}/;

export function blameCommit(repoPath: string, headCommit: string, filePath: string, line: number): string | null {
  const cwd = resolveRepoPath(repoPath);
  try {
    const output = execFileSync(
      'git',
      ['blame', '--porcelain', '-L', `${line},${line}`, headCommit, '--', filePath],
      { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    const match = output.match(FULL_SHA_PATTERN);
    return match ? match[0] : null;
  } catch {
    // File not found at this commit, invalid line number, etc. - the caller
    // treats a null result as "couldn't attribute this line to a commit."
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- git.test.ts`
Expected: PASS — all `lib/git.ts` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/git.ts __tests__/git.test.ts
git commit -m "feat: add blameCommit to lib/git.ts"
```

---

### Task 6: API — `GET /api/prs/[id]` gains `commits` and `?commit=`

**Files:**
- Modify: `app/api/prs/[id]/route.ts:1-34`

**Interfaces:**
- Consumes: `listCommits`, `getCommitDiff`, `CommitInfo` (Tasks 3-4, `lib/git.ts`).
- Produces: `GET /api/prs/[id]` response gains a `commits: CommitInfo[]` field; `?commit=<sha>` query param switches `diff`/`files` to that commit's diff.

- [ ] **Step 1: Manually verify current behavior (no automated test — see note)**

This codebase has no unit tests for any `app/api/**/route.ts` handler (confirmed: no existing test imports any `route.ts`). Route handlers here are verified by running the dev server and hitting the endpoint, not by Jest. Before changing anything, confirm the current baseline:

Run: `npm run dev` (in one terminal), then in another:
```bash
curl -s http://localhost:3000/api/prs/<an-existing-pr-uuid> | head -c 300
```
Expected: JSON containing `"pr"`, `"diff"`, `"files"`, `"comments"` (no `"commits"` yet).

- [ ] **Step 2: Implement the route changes**

Replace the `GET` handler in `app/api/prs/[id]/route.ts` (currently lines 1-34):

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getPRByUuid, getLatestDiff, updatePRStatus, getCommentsWithReplies } from '@/lib/database';
import { listCommits, getCommitDiff } from '@/lib/git';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/prs/[id] - Get PR details
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const pr = getPRByUuid(id);

    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    const commits = listCommits(pr.repo_path, pr.base_commit, pr.head_commit);

    const url = new URL(req.url);
    const commitParam = url.searchParams.get('commit');

    let diff: string | null;
    if (commitParam) {
      if (!commits.some((c) => c.sha === commitParam)) {
        return NextResponse.json({ error: 'Unknown commit for this PR' }, { status: 400 });
      }
      diff = getCommitDiff(pr.repo_path, commitParam);
    } else {
      diff = getLatestDiff(id);
    }

    const comments = getCommentsWithReplies(id);

    // Parse diff to get file list
    const files = parseDiffFiles(diff || '');

    return NextResponse.json({
      pr,
      diff,
      files,
      comments,
      commits,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

(`parseDiffFiles`, the `PATCH` handler, and everything below stay unchanged.)

- [ ] **Step 3: Manually verify the new behavior**

With `npm run dev` still running:
```bash
curl -s http://localhost:3000/api/prs/<an-existing-pr-uuid> | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['commits']), d['commits'][0])"
```
Expected: prints the commit count and the first commit's `{sha, shortSha, message, author, date}` — oldest commit in the PR first.

```bash
SHA=$(curl -s http://localhost:3000/api/prs/<an-existing-pr-uuid> | python3 -c "import json,sys; print(json.load(sys.stdin)['commits'][0]['sha'])")
curl -s "http://localhost:3000/api/prs/<an-existing-pr-uuid>?commit=$SHA" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['files']), 'files')"
```
Expected: a file count that's less than or equal to the cumulative view's file count (a single commit rarely touches every file the whole PR touches).

```bash
curl -s -w '\n%{http_code}\n' "http://localhost:3000/api/prs/<an-existing-pr-uuid>?commit=notasha"
```
Expected: `400` status with `{"error":"Unknown commit for this PR"}`.

- [ ] **Step 4: Run the full TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/prs/[id]/route.ts
git commit -m "feat: serve per-commit diffs from GET /api/prs/[id]"
```

---

### Task 7: API — `POST /api/prs/[id]/comments` accepts `commitSha`

**Files:**
- Modify: `app/api/prs/[id]/comments/route.ts:30-83`

**Interfaces:**
- Consumes: `addComment`'s new `commitSha` param (Task 1).
- Produces: `POST /api/prs/[id]/comments` accepts an optional `commitSha: string` field in the request body.

- [ ] **Step 1: Manually verify current behavior**

Run: `npm run dev`, then:
```bash
curl -s -X POST http://localhost:3000/api/prs/<an-existing-pr-uuid>/comments \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"README.md","lineNumber":1,"content":"baseline check"}'
```
Expected: `{"uuid":"...","message":"Comment added"}` with status 201 (no `commitSha` support yet — this just confirms the endpoint still works before the change).

- [ ] **Step 2: Implement the change**

In `app/api/prs/[id]/comments/route.ts`, update the `POST` handler (currently lines 30-83). Change the destructure line (currently line 34):

```ts
    const { filePath, lineNumber, endLineNumber, content, lineType, commentUuid, author, commitSha } = body;
```

And update the `addComment` call (currently line 73):

```ts
    const newCommentUuid = addComment(
      id,
      filePath,
      lineNumber,
      content,
      lineType || 'new',
      endLineNumber,
      typeof commitSha === 'string' ? commitSha : null
    );
```

- [ ] **Step 3: Manually verify the new behavior**

```bash
curl -s -X POST http://localhost:3000/api/prs/<an-existing-pr-uuid>/comments \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"README.md","lineNumber":1,"content":"commit-scoped check","commitSha":"deadbeef"}'
```
Expected: `{"uuid":"...","message":"Comment added"}` with status 201.

```bash
curl -s http://localhost:3000/api/prs/<an-existing-pr-uuid>/comments | python3 -c "
import json, sys
comments = json.load(sys.stdin)['comments']
c = next(c for c in comments if c['comment']['content'] == 'commit-scoped check')
print(c['comment']['commit_sha'])
"
```
Expected: prints `deadbeef`.

- [ ] **Step 4: Run the full TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/prs/[id]/comments/route.ts
git commit -m "feat: accept commitSha when posting a comment"
```

---

### Task 8: Frontend — commit selector

**Files:**
- Modify: `app/prs/[id]/page.tsx` (interfaces near lines 68-118, state near line 207, `fetchPR`/`useEffect` near lines 327-370, sidebar JSX near lines 777-899)
- Modify: `app/globals.css` (near line 345, after `.deletions`)

**Interfaces:**
- Consumes: `commits: CommitInfo[]` field and `?commit=` support from `GET /api/prs/[id]` (Task 6).
- Produces: `selectedCommit: string | null` state and a `selectCommit(sha: string | null)` handler, consumed by Task 9.

- [ ] **Step 1: Add the `CommitInfo` type and extend `PRData`**

In `app/prs/[id]/page.tsx`, add a new interface right after `FileInfo` (currently lines 106-111) and before `PRData` (currently lines 113-118):

```ts
interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
}
```

Update `PRData` (currently lines 113-118):

```ts
interface PRData {
  pr: PullRequest;
  diff: string;
  files: FileInfo[];
  comments: CommentWithReplies[];
  commits: CommitInfo[];
}
```

- [ ] **Step 2: Add `selectedCommit` state and a `selectCommit` handler**

Add a new import for the icons used by the commit list. Update the `lucide-react` import (currently lines 8-31) by adding `GitCommit` and `Layers` to the list:

```ts
import {
  ArrowLeft,
  GitPullRequest,
  CheckCircle,
  XCircle,
  Clock,
  GitMerge,
  MessageSquare,
  File,
  FileText,
  Eye,
  Code,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Plus,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Folder,
  FolderOpen,
  Sparkles,
  Loader2,
  GitCommit,
  Layers,
} from 'lucide-react';
```

Add new state right after `const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());` (currently line 207):

```ts
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
```

- [ ] **Step 3: Make `fetchPR` commit-aware and add `selectCommit`**

Replace `fetchPR` (currently lines 350-370):

```ts
  const fetchPR = async (commit: string | null = selectedCommit) => {
    setLoading(true);
    try {
      const query = commit ? `?commit=${encodeURIComponent(commit)}` : '';
      const res = await fetch(`/api/prs/${id}${query}`);
      if (!res.ok) throw new Error('PR not found');
      const prData = await res.json();
      setData(prData);
      // For large PRs (>10 files), only expand first 3 files for performance
      // For smaller PRs, expand all
      const files = prData.files as FileInfo[];
      if (files.length > 10) {
        setExpandedFiles(new Set(files.slice(0, 3).map(f => f.path)));
      } else {
        setExpandedFiles(new Set(files.map(f => f.path)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading PR');
    } finally {
      setLoading(false);
    }
  };

  const selectCommit = (sha: string | null) => {
    setSelectedCommit(sha);
    fetchPR(sha);
  };
```

The polling `useEffect` (currently lines 327-348) needs no change: it only merges `comments` and `pr.status` into the existing `data`, both of which are identical regardless of which commit is selected, so it can't clobber the currently-displayed diff.

- [ ] **Step 4: Render the commit selector in the sidebar**

Insert a new sidebar section right after the "Files Changed" section's closing tags (currently the `</div>` at line 852 that closes `<div className="sidebar-section">` for Files Changed) and before the `{/* Review Panel */}` comment (currently line 854):

```tsx
          <div className="sidebar-section">
            <h3>Commits ({data.commits.length})</h3>
            <div className="file-list">
              <button
                className={`file-item commit-item ${selectedCommit === null ? 'active' : ''}`}
                onClick={() => selectCommit(null)}
              >
                <Layers size={14} />
                <span className="file-name">All commits</span>
              </button>
              {data.commits.map((commit) => (
                <button
                  key={commit.sha}
                  className={`file-item commit-item ${selectedCommit === commit.sha ? 'active' : ''}`}
                  onClick={() => selectCommit(commit.sha)}
                  title={`${commit.shortSha} by ${commit.author}`}
                >
                  <GitCommit size={14} />
                  <span className="file-name">{commit.message}</span>
                  <span className="commit-sha">{commit.shortSha}</span>
                </button>
              ))}
            </div>
          </div>
```

- [ ] **Step 5: Add CSS for the commit rows**

In `app/globals.css`, add right after the `.deletions` rule (currently lines 342-345):

```css
.commit-sha {
  font-family: monospace;
  font-size: 0.75rem;
  color: #8b949e;
  margin-left: auto;
  flex-shrink: 0;
}
```

(`.commit-item` reuses `.file-item`'s existing layout/hover/active styles verbatim via the shared class name — no separate rule needed.)

- [ ] **Step 6: Manually verify**

Run: `npm run dev`, open `http://localhost:3000/prs/<a-multi-commit-pr-uuid>` in a browser.

Expected: a "Commits (N)" sidebar section appears between "Files Changed" and "Submit Review", listing "All commits" followed by one row per commit (oldest first), each showing its message and short SHA. "All commits" is highlighted by default. Clicking a commit highlights it instead and the diff below updates to that commit's changes only; clicking "All commits" returns to the full cumulative diff.

- [ ] **Step 7: Commit**

```bash
git add app/prs/[id]/page.tsx app/globals.css
git commit -m "feat: add commit selector to PR review page"
```

---

### Task 9: Frontend — scope comments to the selected commit

**Files:**
- Modify: `app/prs/[id]/page.tsx` (`Comment` interface at lines 89-99, `addComment` at lines 403-460, `getFileComments` at lines 658-661)

**Interfaces:**
- Consumes: `selectedCommit` state (Task 8, same file); `commit_sha` field and `commitSha` POST param (Tasks 1, 7).

- [ ] **Step 1: Add `commit_sha` to the client-side `Comment` interface**

Update `Comment` (currently lines 89-99):

```ts
interface Comment {
  id: number;
  uuid: string;
  file_path: string;
  line_number: number;
  end_line_number: number;
  commit_sha: string | null;
  line_type: 'old' | 'new' | 'context';
  content: string;
  resolved: boolean;
  created_at: string;
}
```

- [ ] **Step 2: Filter inline comments by the selected commit**

Update `getFileComments` (currently lines 658-661) — this is the single source that `fileComments` is derived from wherever it's used in the render (the thread-render, containment/highlight, and pending-selection predicates all read from it), so filtering here scopes all of them at once:

```ts
  const getFileComments = (filePath: string): CommentWithReplies[] => {
    if (!data) return [];
    return data.comments.filter(
      (c) => c.comment.file_path === filePath && c.comment.commit_sha === selectedCommit
    );
  };
```

- [ ] **Step 3: Tag new comments with the selected commit**

Update the optimistic comment object inside `addComment()` (currently lines 407-420):

```ts
    const newCommentObj: CommentWithReplies = {
      comment: {
        id: Date.now(),
        uuid: tempUuid,
        file_path: commentingAt.file,
        line_number: commentingAt.startLine,
        end_line_number: commentingAt.endLine,
        commit_sha: selectedCommit,
        line_type: commentingAt.lineType,
        content: newComment,
        resolved: false,
        created_at: new Date().toISOString(),
      },
      replies: [],
    };
```

Update the POST body inside the same function (currently lines 431-442):

```ts
    try {
      const res = await fetch(`/api/prs/${id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: commentingAt.file,
          lineNumber: commentingAt.startLine,
          endLineNumber: commentingAt.endLine,
          lineType: commentingAt.lineType,
          commitSha: selectedCommit,
          content: newComment,
        }),
      });
```

- [ ] **Step 4: Manually verify**

With `npm run dev` running, open a multi-commit PR:

1. Select a specific commit in the sidebar, click a line in its diff, and add a comment.
2. Confirm the comment appears inline immediately (optimistic update).
3. Switch to "All commits" — confirm the comment does **not** appear.
4. Switch back to the same commit — confirm it reappears.
5. Reload the page (resets to "All commits" — `selectedCommit` is in-memory state, not persisted in the URL, which is expected). Select the same commit again and confirm the comment is still there (proves it round-tripped through the server, not just the optimistic update).
6. Add a comment while viewing "All commits"; confirm it appears there but not under any individual commit.

- [ ] **Step 5: Run the full TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/prs/[id]/page.tsx
git commit -m "feat: scope inline comments to the selected commit"
```

---

### Task 10: AI auto-review — attribute comments to a commit via blame

**Files:**
- Modify: `app/api/prs/[id]/ai-review/route.ts:1-13` (imports), `:119-131` (comment-adding loop)

**Interfaces:**
- Consumes: `listCommits`, `blameCommit` (Tasks 3, 5, `lib/git.ts`); `addComment`'s `commitSha` param (Task 1).

- [ ] **Step 1: Manually verify current behavior**

This route calls out to the `claude` CLI and needs a real repo + API access, so (like every other route in this app) it has no unit test — verify manually. With `npm run dev` running and a real PR loaded, click "AI Review" and confirm it still posts comments as before (baseline, before this task's change).

- [ ] **Step 2: Implement commit attribution**

Add an import to `app/api/prs/[id]/ai-review/route.ts` (currently lines 1-3):

```ts
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { getPRByUuid, addComment, getLatestDiff } from '@/lib/database';
import { listCommits, blameCommit } from '@/lib/git';
```

Replace the comment-adding loop (currently lines 119-131):

```ts
    // Attribute each comment to whichever commit last touched that line,
    // restricted to commits within this PR's range - an unrestricted blame
    // match means the line predates the PR, so it stays cumulative-scoped.
    const commits = listCommits(pr.repo_path, pr.base_commit, pr.head_commit);
    const commitShas = new Set(commits.map((c) => c.sha));

    const addedComments: string[] = [];
    for (const comment of comments) {
      if (comment.file_path && comment.line_number && comment.content) {
        const blamedSha = blameCommit(pr.repo_path, pr.head_commit, comment.file_path, comment.line_number);
        const commitSha = blamedSha && commitShas.has(blamedSha) ? blamedSha : null;
        const uuid = addComment(
          id,
          comment.file_path,
          comment.line_number,
          comment.content,
          'new',
          comment.line_number,
          commitSha
        );
        addedComments.push(uuid);
      }
    }
```

- [ ] **Step 3: Manually verify**

With `npm run dev` running against a real multi-commit PR, trigger AI review (click "AI Review" in the browser, or `curl -X POST http://localhost:3000/api/prs/<pr-uuid>/ai-review`), then:

```bash
curl -s http://localhost:3000/api/prs/<pr-uuid>/comments | python3 -c "
import json, sys
comments = json.load(sys.stdin)['comments']
tagged = [c['comment'] for c in comments if c['comment']['commit_sha']]
print(f'{len(tagged)} of {len(comments)} comments have a commit_sha')
for c in tagged[:3]:
    print(c['file_path'], c['line_number'], c['commit_sha'][:7])
"
```
Expected: at least one comment (assuming the AI found something to comment on in a line that was actually changed by a specific commit) shows a `commit_sha` matching one of the PR's commits, and switching to that commit's view in the browser shows the comment inline.

- [ ] **Step 4: Run the full TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/prs/[id]/ai-review/route.ts
git commit -m "feat: attribute AI auto-review comments to their owning commit"
```

---

### Task 11: CLI — show commit scope in comment display

**Files:**
- Modify: `claude-reviewer-cli/claude_reviewer/cli.py:35-62` (`print_comment`), `:241-253` (`comments --format json`)
- Test: `claude-reviewer-cli/tests/test_cli.py`

**Interfaces:**
- Consumes: `Comment.commit_sha` (Task 2).

- [ ] **Step 1: Write the failing test**

Update the import line in `claude-reviewer-cli/tests/test_cli.py` (currently line 13):

```python
from claude_reviewer.cli import get_local_server_pid_file, main, print_comment, stop_local_server
from claude_reviewer.models import Comment
```

Add a new test class at the end of `claude-reviewer-cli/tests/test_cli.py`:

```python
class TestPrintComment:
    """Tests for print_comment's commit-scope display."""

    def test_shows_short_sha_for_a_commit_scoped_comment(self, capsys: pytest.CaptureFixture[str]) -> None:
        """A comment tagged with a commit shows that commit's short SHA."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="looks good",
            commit_sha="0123456789abcdef",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "a.py:1 [0123456]" in output

    def test_omits_commit_tag_for_a_cumulative_comment(self, capsys: pytest.CaptureFixture[str]) -> None:
        """A comment with no commit_sha (cumulative view) shows no commit tag."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="looks good",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "a.py:1  ·" in output
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-reviewer-cli && pytest tests/test_cli.py -k TestPrintComment -v`
Expected: FAIL — `test_shows_short_sha_for_a_commit_scoped_comment` fails because the output doesn't contain `"a.py:1 [0123456]"` (current `print_comment` doesn't render `commit_sha` at all).

- [ ] **Step 3: Implement the display change**

Replace `print_comment` in `claude-reviewer-cli/claude_reviewer/cli.py` (currently lines 35-62):

```python
def print_comment(
    c: Comment, replies: list[CommentReply] | None = None, indent: str = "  "
) -> None:
    """Print a single comment as a scannable location header + indented content.

    highlight=False avoids Rich's automatic ReprHighlighter, which otherwise
    bolds numbers/brackets/parens inside the file path and content, producing
    jumbled, inconsistent coloring.
    """
    side_note = " [dim]\\[old-side][/dim]" if c.line_type == "old" else ""
    commit_note = f" [dim]\\[{c.commit_sha[:7]}][/dim]" if c.commit_sha else ""
    resolved_note = " [dim]\\[resolved][/dim]" if c.resolved else ""
    line_ref = (
        f"{c.line_number}-{c.end_line_number}"
        if c.end_line_number != c.line_number
        else str(c.line_number)
    )
    console.print(
        f"{indent}[cyan]{c.file_path}:{line_ref}[/cyan]{side_note}{commit_note}{resolved_note}  "
        f"[dim]· {c.uuid}[/dim]",
        highlight=False,
    )
    console.print(f"{indent}  {c.content}", highlight=False)
    for reply in replies or []:
        author_color = "green" if reply.author == "claude" else "blue"
        console.print(
            f"{indent}  [{author_color}]↳ {reply.author}:[/{author_color}] {reply.content}",
            highlight=False,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claude-reviewer-cli && pytest tests/test_cli.py -k TestPrintComment -v`
Expected: PASS.

- [ ] **Step 5: Add the JSON field**

Update the `"comments"` list comprehension in the `comments` command (currently lines 241-253):

```python
            "comments": [
                {
                    "uuid": c.uuid,
                    "file": c.file_path,
                    "line": c.line_number,
                    "end_line": c.end_line_number,
                    "commit_sha": c.commit_sha,
                    "line_type": c.line_type,
                    "text": c.content,
                    "resolved": c.resolved,
                    "replies": [{"author": r.author, "text": r.content} for r in replies],
                }
                for c, replies in comments_with_replies
            ],
```

No test covers this specific line: this codebase has no existing CliRunner+temp-DB test harness for the `comments` command at all (confirmed — nothing references it in `tests/`), and building that scaffolding just to check one dict key is disproportionate to a one-line change. It's covered instead by Task 12's manual pass.

- [ ] **Step 6: Run the full Python test suite and lint**

Run: `cd claude-reviewer-cli && make check`
Expected: all tests pass, `ruff`/`black`/`isort`/`mypy` report no issues.

- [ ] **Step 7: Commit**

```bash
git add claude-reviewer-cli/claude_reviewer/cli.py claude-reviewer-cli/tests/test_cli.py
git commit -m "feat: show commit scope in CLI comment display"
```

---

### Task 12: Full verification pass

**Files:** none — this task only runs checks and exercises the feature end-to-end; nothing to commit.

- [ ] **Step 1: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: JS/TS test suite**

Run: `npm test`
Expected: all tests pass, including every new test added in Tasks 1 and 3-5.

- [ ] **Step 3: Python lint, typecheck, and test suite**

Run: `cd claude-reviewer-cli && make check`
Expected: `ruff`, `black --check`, `isort --check-only`, `mypy`, and `pytest` all pass, including every new test added in Tasks 2 and 11.

- [ ] **Step 4: Full manual pass**

Run: `npm run build && PORT=41729 npm run start`. Using a real repo with a multi-commit PR (create one with `claude-reviewer create` if needed), open it in a browser at `http://localhost:41729/prs/<pr-uuid>` and confirm, in order:

1. The PR opens on the cumulative "All commits" view by default (unchanged from before this feature).
2. The "Commits (N)" sidebar section lists every commit between base and head, oldest first, each with a message and short SHA.
3. Clicking each commit in turn updates the diff below to that commit's changes only; clicking "All commits" returns to the full diff.
4. Adding a comment while viewing a specific commit makes it appear only under that commit and not under "All commits" or any other commit.
5. Adding a comment while viewing "All commits" makes it appear only there.
6. Clicking "AI Review" posts comments, and at least one shows a commit tag matching one of the PR's commits when that commit's view is selected.
7. `claude-reviewer comments <pr-id>` shows a `[shortsha]` tag next to any commit-scoped comment, and shows nothing extra for cumulative-scoped ones.
8. `claude-reviewer comments <pr-id> --format json` includes a `"commit_sha"` key for every comment, `null` for cumulative-scoped ones.

