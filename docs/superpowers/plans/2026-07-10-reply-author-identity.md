# Reply Author Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `'ben'`/`'user'`/`'claude'` reply-author literals with a real `authors` roster (human + agent identities), full CRUD on both the CLI and a new web settings page, and a `settings` table holding which author is the default for each kind.

**Architecture:** A new `authors` table (id, kind, name, email) is referenced by FK (`author_id`) from `comment_replies` and `repo_conversation_messages`, replacing their old free-text `author` column entirely. A new `settings` table holds exactly two pointers (`default_human_author_id`, `default_agent_author_id`) that CLI sentinels (`--author me` / `--author claude`) and the web reply flow resolve through. Both the Next.js app (`lib/database.ts`) and the Python CLI (`claude_reviewer/database.py`) implement the same schema and CRUD operations independently against the shared SQLite file, mirroring the existing dual-implementation pattern already used for every other table.

**Tech Stack:** Next.js (App Router) + better-sqlite3 on the web side; Python + Click + raw `sqlite3` on the CLI side; Vitest for TS tests, pytest for Python tests.

## Global Constraints

- Existing `comment_replies`/`repo_conversation_messages` data is discarded on upgrade (both tables are dropped and recreated in the new shape) — this is pre-1.0 local dev tooling and the user has explicitly confirmed data loss is acceptable. Do not build a backfill.
- `author_id` is `NOT NULL` on both tables — never nullable, no legacy text-column fallback.
- `authors.name` is `UNIQUE COLLATE NOCASE` — name lookups are always case-insensitive.
- The CLI's `--author` default stays the literal string `"claude"` — never change this default, since `CLAUDE.md`'s documented workflow relies on it.
- `kind` on `authors` is immutable after creation — only `name`/`email` are ever updated.
- Deletion is block-only: refuse if referenced by any reply/message, or if it's a current default. No cascade-delete, no force flag.
- Every new SQL/schema addition goes in *both* `lib/database.ts` and `claude_reviewer/database.py` — they do not share code, so each change must be hand-mirrored.
- Full spec: `docs/superpowers/specs/2026-07-10-reply-author-settings-design.md`.

---

## Task 1: Git identity helper (TS)

**Files:**
- Modify: `lib/git.ts`
- Test: `__tests__/git.test.ts`

**Interfaces:**
- Produces: `getGitUserIdentity(): { name: string | null; email: string | null }` — reads the machine's global git config. Used by Task 3's seeding logic.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/git.test.ts` (new `describe` block, following the existing `resolveRepoPath` block's save/restore-env pattern):

```ts
describe("getGitUserIdentity", () => {
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

  test("reads name and email from a global .gitconfig", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reviewer-gitconfig-test-"));
    fs.writeFileSync(
      path.join(tmpHome, ".gitconfig"),
      "[user]\n\tname = Test User\n\temail = test@example.com\n"
    );
    process.env.HOME = tmpHome;

    const identity = getGitUserIdentity();
    expect(identity.name).toBe("Test User");
    expect(identity.email).toBe("test@example.com");
  });

  test("returns nulls when no global git config exists", () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reviewer-gitconfig-test-"));
    process.env.HOME = tmpHome;

    const identity = getGitUserIdentity();
    expect(identity.name).toBeNull();
    expect(identity.email).toBeNull();
  });
});
```

Add `getGitUserIdentity` to the existing import line at the top of the file:

```ts
import { resolveRepoPath, listCommits, getCommitDiff, blameCommit, getGitUserIdentity } from "../lib/git";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run __tests__/git.test.ts`
Expected: FAIL with `getGitUserIdentity is not a function` (or a TS import error).

- [ ] **Step 3: Write minimal implementation**

Add to `lib/git.ts`, after the existing `blameCommit` function (after line 92):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run __tests__/git.test.ts`
Expected: PASS (all tests in the file, including the two new ones)

- [ ] **Step 5: Commit**

```bash
git add lib/git.ts __tests__/git.test.ts
git commit -m "feat: add getGitUserIdentity to read global git config"
```

---

## Task 2: Git identity helper (Python)

**Files:**
- Modify: `claude-reviewer-cli/claude_reviewer/git_ops.py`
- Test: `claude-reviewer-cli/tests/test_git_ops.py`

**Interfaces:**
- Produces: `get_global_git_user() -> tuple[str | None, str | None]` (name, email) — module-level function (not a `GitOps` method, since it isn't tied to any specific repo). Used by Task 4's seeding logic.

- [ ] **Step 1: Write the failing test**

Add to `claude-reviewer-cli/tests/test_git_ops.py`, after the existing imports:

```python
import os

from claude_reviewer.git_ops import get_global_git_user
```

Add a new test class at the end of the file:

```python
class TestGetGlobalGitUser:
    """Tests for get_global_git_user."""

    def test_reads_name_and_email_from_global_gitconfig(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_home:
            gitconfig = Path(tmp_home) / ".gitconfig"
            gitconfig.write_text("[user]\n\tname = Test User\n\temail = test@example.com\n")
            monkeypatch.setenv("HOME", tmp_home)

            name, email = get_global_git_user()
            assert name == "Test User"
            assert email == "test@example.com"

    def test_returns_none_when_no_global_config_exists(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_home:
            monkeypatch.setenv("HOME", tmp_home)

            name, email = get_global_git_user()
            assert name is None
            assert email is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/test_git_ops.py::TestGetGlobalGitUser -v`
Expected: FAIL with `ImportError: cannot import name 'get_global_git_user'`

- [ ] **Step 3: Write minimal implementation**

Add to `claude_reviewer/git_ops.py`, after the imports (after line 9), before the `GitResult` class:

```python
import subprocess


def get_global_git_user() -> tuple[str | None, str | None]:
    """Read the machine's global git user.name/user.email, if configured.

    Not tied to any specific repository - reflects whatever `git config
    --global` resolves to, independent of GitOps' repo-scoped operations.
    """
    return (_try_global_git_config("user.name"), _try_global_git_config("user.email"))


def _try_global_git_config(key: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "config", "--global", "--get", key],
            capture_output=True,
            text=True,
            check=True,
        )
        value = result.stdout.strip()
        return value or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/test_git_ops.py -v`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 5: Commit**

```bash
git add claude-reviewer-cli/claude_reviewer/git_ops.py claude-reviewer-cli/tests/test_git_ops.py
git commit -m "feat: add get_global_git_user to read global git config"
```

---

## Task 3: Authors + settings schema, seeding, and CRUD (TS)

**Files:**
- Modify: `lib/database.ts`
- Test: `__tests__/database.test.ts`

**Interfaces:**
- Consumes: `getGitUserIdentity()` from Task 1.
- Produces:
  - `interface Author { id: number; kind: AuthorKind; name: string; email: string | null; created_at: string; updated_at: string; }`
  - `getSetting(key: string): string | null`, `setSetting(key: string, value: string): void`
  - `listAuthors(): Author[]`
  - `getAuthorById(id: number): Author | null`
  - `getAuthorByName(name: string): Author | null`
  - `getDefaultHumanAuthor(): Author`, `getDefaultAgentAuthor(): Author`
  - `createAuthor(kind: AuthorKind, name: string, email?: string | null): Author`
  - `updateAuthor(id: number, updates: { name?: string; email?: string | null }): Author`
  - `deleteAuthor(id: number): void`
  - `setDefaultAuthor(id: number): void`
  All consumed by Task 5/7 (write/read path rewiring) and Task 9 (API routes).

- [ ] **Step 1: Write the failing tests**

Add `better-sqlite3`'s default import to `__tests__/database.test.ts`'s existing `fs`/`os`/`path` import block at the top of the file (this test file needs to open a raw connection to the test DB for one setup step below):

```ts
import Database from "better-sqlite3";
```

Add to the import list from `"../lib/database"`:

```ts
import {
  createPR,
  getPRByUuid,
  getPRById,
  listPRs,
  updatePRStatus,
  getLatestDiff,
  updatePRDiff,
  addComment,
  getComments,
  resolveComment,
  deleteComment,
  submitReview,
  getReviews,
  closeDatabase,
  listAuthors,
  getAuthorById,
  getAuthorByName,
  getDefaultHumanAuthor,
  getDefaultAgentAuthor,
  createAuthor,
  updateAuthor,
  deleteAuthor,
  setDefaultAuthor,
} from "../lib/database";
```

Add a new `describe` block before the final closing `});` of `describe("Database Module", ...)`:

```ts
  describe("Author Operations", () => {
    test("seeding creates exactly one agent row named claude", () => {
      const authors = listAuthors();
      const agents = authors.filter((a) => a.kind === "agent");
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe("claude");
    });

    test("seeding creates exactly one human row", () => {
      const authors = listAuthors();
      const humans = authors.filter((a) => a.kind === "human");
      expect(humans.length).toBe(1);
    });

    test("getDefaultHumanAuthor and getDefaultAgentAuthor resolve the seeded rows", () => {
      const human = getDefaultHumanAuthor();
      const agent = getDefaultAgentAuthor();
      expect(human.kind).toBe("human");
      expect(agent.kind).toBe("agent");
      expect(agent.name).toBe("claude");
    });

    test("createAuthor adds a new row and getAuthorByName finds it case-insensitively", () => {
      const created = createAuthor("human", "Alice", "alice@example.com");
      expect(created.id).toBeDefined();
      expect(created.email).toBe("alice@example.com");

      const found = getAuthorByName("ALICE");
      expect(found?.id).toBe(created.id);
    });

    test("createAuthor rejects a duplicate name case-insensitively", () => {
      createAuthor("human", "Bob");
      expect(() => createAuthor("human", "bob")).toThrow(/already exists/i);
    });

    test("updateAuthor changes name and email without touching kind", () => {
      const created = createAuthor("human", "Carol");
      const updated = updateAuthor(created.id, { name: "Caroline", email: "c@example.com" });
      expect(updated.name).toBe("Caroline");
      expect(updated.email).toBe("c@example.com");
      expect(updated.kind).toBe("human");
    });

    test("deleteAuthor refuses to delete an author referenced by a reply", () => {
      const author = createAuthor("human", "Dave");
      const prUuid = createPR("/repo/authors", "Author Test PR", "main", "feature", "a", "b", "diff");
      const commentUuid = addComment(prUuid, "file.py", 1, "a comment");
      // addReply isn't rewired onto author_id until Task 5, so for this task
      // insert directly against the schema to set up a referencing row.
      const rawDb = new Database(testDbPath);
      const comment = rawDb.prepare("SELECT id FROM comments WHERE uuid = ?").get(commentUuid) as { id: number };
      rawDb.prepare(
        "INSERT INTO comment_replies (uuid, comment_id, author_id, content) VALUES (?, ?, ?, ?)"
      ).run("replyuuid1", comment.id, author.id, "a reply");
      rawDb.close();

      expect(() => deleteAuthor(author.id)).toThrow(/referenced by 1 reply/i);
    });

    test("deleteAuthor refuses to delete the current default", () => {
      const human = getDefaultHumanAuthor();
      expect(() => deleteAuthor(human.id)).toThrow(/current default/i);
    });

    test("deleteAuthor succeeds for an unreferenced, non-default author", () => {
      const author = createAuthor("human", "Eve");
      deleteAuthor(author.id);
      expect(getAuthorById(author.id)).toBeUndefined();
    });

    test("setDefaultAuthor repoints the default for that author's kind", () => {
      const newHuman = createAuthor("human", "Frank");
      setDefaultAuthor(newHuman.id);
      expect(getDefaultHumanAuthor().id).toBe(newHuman.id);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run __tests__/database.test.ts`
Expected: FAIL with `listAuthors is not a function` (or similar import errors)

- [ ] **Step 3: Write minimal implementation**

In `lib/database.ts`, add the import at the top (line 4, after `import fs from 'fs';`):

```ts
import { getGitUserIdentity } from './git';
```

Add the `Author` interface after the `CommentReply` interface (after line 60):

```ts
export interface Author {
  id: number;
  kind: AuthorKind;
  name: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}
```

Replace the `comment_replies` and `repo_conversation_messages` table definitions inside `initSchema`'s `db.exec` block. Change (lines 218-226):

```sql
    -- Comment replies table
    CREATE TABLE IF NOT EXISTS comment_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        author TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
```

to:

```sql
    -- Authors table (human + agent identities)
    CREATE TABLE IF NOT EXISTS authors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_authors_kind ON authors(kind);

    -- Settings table (default-author pointers only, not a generic KV store)
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Comment replies table
    CREATE TABLE IF NOT EXISTS comment_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES authors(id),
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
```

And change the `repo_conversation_messages` definition (lines 254-261) from:

```sql
    CREATE TABLE IF NOT EXISTS repo_conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        conversation_id INTEGER NOT NULL REFERENCES repo_conversations(id) ON DELETE CASCADE,
        author TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
```

to:

```sql
    CREATE TABLE IF NOT EXISTS repo_conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        conversation_id INTEGER NOT NULL REFERENCES repo_conversations(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES authors(id),
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
```

Replace the `initSchema` function body (lines 154-269) to add the pre-step rebuild and post-step seeding:

```ts
function initSchema(db: Database.Database): void {
  rebuildReplyTablesIfPreAuthors(db);

  db.exec(`
    -- Pull Requests table
    ... (unchanged - keep every existing CREATE TABLE/INDEX statement as-is
         except the two edits above) ...
  `);

  seedAuthors(db);
  migrateCommentsEndLine(db);
  migrateCommentsCommitSha(db);
}

// A database created before the authors table existed has comment_replies/
// repo_conversation_messages in the old author-TEXT-column shape. Rather than
// backfill (existing reply data is not preserved - see the design spec),
// drop and let the CREATE TABLE IF NOT EXISTS block below recreate both
// tables in the new author_id-based shape.
function rebuildReplyTablesIfPreAuthors(db: Database.Database): void {
  const authorsExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'authors'`
  ).get();
  if (!authorsExists) {
    db.exec('DROP TABLE IF EXISTS comment_replies');
    db.exec('DROP TABLE IF EXISTS repo_conversation_messages');
  }
}

// Seeds the one-time default agent ('claude') and default human (from git
// config, if available) rows, plus the settings pointers to them. Guarded so
// it only inserts rows/pointers that don't exist yet - safe to call on every
// getDatabase() reconnect.
function seedAuthors(db: Database.Database): void {
  let agent = db.prepare(`SELECT id FROM authors WHERE kind = 'agent'`).get() as { id: number } | undefined;
  if (!agent) {
    const result = db.prepare(`INSERT INTO authors (kind, name) VALUES ('agent', 'claude')`).run();
    agent = { id: result.lastInsertRowid as number };
  }

  let human = db.prepare(`SELECT id FROM authors WHERE kind = 'human'`).get() as { id: number } | undefined;
  if (!human) {
    const identity = getGitUserIdentity();
    const result = db.prepare(
      `INSERT INTO authors (kind, name, email) VALUES ('human', ?, ?)`
    ).run(identity.name || 'reviewer', identity.email);
    human = { id: result.lastInsertRowid as number };
  }

  const hasDefaultAgent = db.prepare(`SELECT 1 FROM settings WHERE key = 'default_agent_author_id'`).get();
  if (!hasDefaultAgent) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('default_agent_author_id', ?)`).run(String(agent.id));
  }

  const hasDefaultHuman = db.prepare(`SELECT 1 FROM settings WHERE key = 'default_human_author_id'`).get();
  if (!hasDefaultHuman) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('default_human_author_id', ?)`).run(String(human.id));
  }
}
```

Add the CRUD operations as a new section at the end of the file, before `// Utility` (before line 825):

```ts
// =============================================================================
// Author Operations
// =============================================================================

export function getSetting(key: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
  checkpoint();
}

export function listAuthors(): Author[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM authors ORDER BY kind, name').all() as Author[];
}

export function getAuthorById(id: number): Author | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM authors WHERE id = ?').get(id);
  return row as Author | null;
}

export function getAuthorByName(name: string): Author | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM authors WHERE name = ? COLLATE NOCASE').get(name);
  return row as Author | null;
}

export function getDefaultHumanAuthor(): Author {
  const id = getSetting('default_human_author_id');
  const author = id ? getAuthorById(Number(id)) : null;
  if (!author) throw new Error('No default human author configured');
  return author;
}

export function getDefaultAgentAuthor(): Author {
  const id = getSetting('default_agent_author_id');
  const author = id ? getAuthorById(Number(id)) : null;
  if (!author) throw new Error('No default agent author configured');
  return author;
}

export function createAuthor(kind: AuthorKind, name: string, email: string | null = null): Author {
  const db = getDatabase();
  try {
    const result = db.prepare(
      'INSERT INTO authors (kind, name, email) VALUES (?, ?, ?)'
    ).run(kind, name, email);
    checkpoint();
    return getAuthorById(result.lastInsertRowid as number)!;
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw new Error(`An author named "${name}" already exists`);
    }
    throw e;
  }
}

export function updateAuthor(id: number, updates: { name?: string; email?: string | null }): Author {
  const db = getDatabase();
  const existing = getAuthorById(id);
  if (!existing) throw new Error(`Author ${id} not found`);

  const name = updates.name ?? existing.name;
  const email = updates.email !== undefined ? updates.email : existing.email;

  try {
    db.prepare(
      'UPDATE authors SET name = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(name, email, id);
    checkpoint();
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw new Error(`An author named "${name}" already exists`);
    }
    throw e;
  }
  return getAuthorById(id)!;
}

export function deleteAuthor(id: number): void {
  const db = getDatabase();
  const author = getAuthorById(id);
  if (!author) throw new Error(`Author ${id} not found`);

  const replyCount = (db.prepare('SELECT COUNT(*) as count FROM comment_replies WHERE author_id = ?').get(id) as { count: number }).count;
  const messageCount = (db.prepare('SELECT COUNT(*) as count FROM repo_conversation_messages WHERE author_id = ?').get(id) as { count: number }).count;
  const totalReferences = replyCount + messageCount;
  if (totalReferences > 0) {
    throw new Error(`Cannot delete "${author.name}" - referenced by ${totalReferences} repl${totalReferences === 1 ? 'y' : 'ies'}`);
  }

  const defaultKey = author.kind === 'human' ? 'default_human_author_id' : 'default_agent_author_id';
  if (getSetting(defaultKey) === String(id)) {
    throw new Error(`Cannot delete "${author.name}" - it's the current default ${author.kind}. Set a different default first.`);
  }

  db.prepare('DELETE FROM authors WHERE id = ?').run(id);
  checkpoint();
}

export function setDefaultAuthor(id: number): void {
  const author = getAuthorById(id);
  if (!author) throw new Error(`Author ${id} not found`);
  const key = author.kind === 'human' ? 'default_human_author_id' : 'default_agent_author_id';
  setSetting(key, String(id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run __tests__/database.test.ts`
Expected: PASS (all tests, including the new "Author Operations" block). `__tests__/database.test.ts` has no pre-existing tests that call `addReply`/`addRepoConversationMessage`/`createRepoConversation` today, so this change doesn't break anything else in the file - those functions get their own rewired tests in Tasks 5 and 7.

- [ ] **Step 5: Commit**

```bash
git add lib/database.ts __tests__/database.test.ts
git commit -m "feat: add authors/settings schema, seeding, and CRUD (TS)"
```

---

## Task 4: Authors + settings schema, seeding, and CRUD (Python)

**Files:**
- Modify: `claude-reviewer-cli/claude_reviewer/database.py`
- Modify: `claude-reviewer-cli/claude_reviewer/models.py`
- Test: `claude-reviewer-cli/tests/test_database.py`

**Interfaces:**
- Consumes: `get_global_git_user()` from Task 2.
- Produces:
  - `Author` dataclass: `id: int`, `kind: str`, `name: str`, `email: str | None`, `created_at`, `updated_at`
  - `get_setting(key: str) -> str | None`, `set_setting(key: str, value: str) -> None`
  - `list_authors() -> list[Author]`
  - `get_author_by_id(author_id: int) -> Author | None`
  - `get_author_by_name(name: str) -> Author | None`
  - `get_default_human_author() -> Author`, `get_default_agent_author() -> Author`
  - `create_author(kind: str, name: str, email: str | None = None) -> Author`
  - `update_author(author_id: int, name: str | None = None, email: str | None = None) -> Author`
  - `delete_author(author_id: int) -> None`
  - `set_default_author(author_id: int) -> None`
  All consumed by Task 6/8 (write/read path rewiring) and Task 15 (CLI commands).

- [ ] **Step 1: Write the failing tests**

Add to `claude-reviewer-cli/claude_reviewer/models.py`, after the `CommentReply` dataclass (after line 80):

```python
@dataclass
class Author:
    id: int
    kind: str  # "human" | "agent"
    name: str
    email: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
```

Add to `claude-reviewer-cli/tests/test_database.py`, after the existing imports:

```python
import pytest
```

(if not already imported at module level - check first; `pytest` is already imported at the top of the file per the fixture, so this may be a no-op).

Add a new test class at the end of the file:

```python
class TestAuthors:
    """Tests for author operations."""

    def test_seeding_creates_one_agent_row_named_claude(self, temp_db: Path) -> None:
        authors = db.list_authors()
        agents = [a for a in authors if a.kind == "agent"]
        assert len(agents) == 1
        assert agents[0].name == "claude"

    def test_seeding_creates_one_human_row(self, temp_db: Path) -> None:
        authors = db.list_authors()
        humans = [a for a in authors if a.kind == "human"]
        assert len(humans) == 1

    def test_get_default_human_and_agent_authors(self, temp_db: Path) -> None:
        human = db.get_default_human_author()
        agent = db.get_default_agent_author()
        assert human.kind == "human"
        assert agent.kind == "agent"
        assert agent.name == "claude"

    def test_create_author_and_get_by_name_case_insensitive(self, temp_db: Path) -> None:
        created = db.create_author("human", "Alice", "alice@example.com")
        assert created.id is not None
        assert created.email == "alice@example.com"

        found = db.get_author_by_name("ALICE")
        assert found is not None
        assert found.id == created.id

    def test_create_author_rejects_duplicate_name_case_insensitive(self, temp_db: Path) -> None:
        db.create_author("human", "Bob")
        with pytest.raises(ValueError, match="already exists"):
            db.create_author("human", "bob")

    def test_update_author_changes_name_and_email(self, temp_db: Path) -> None:
        created = db.create_author("human", "Carol")
        updated = db.update_author(created.id, name="Caroline", email="c@example.com")
        assert updated.name == "Caroline"
        assert updated.email == "c@example.com"
        assert updated.kind == "human"

    def test_delete_author_refuses_referenced_author(self, temp_db: Path) -> None:
        author = db.create_author("human", "Dave")
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")
        db.add_reply(comment_uuid, "a reply", author=author.name)

        with pytest.raises(ValueError, match="referenced by 1 reply"):
            db.delete_author(author.id)

    def test_delete_author_refuses_current_default(self, temp_db: Path) -> None:
        human = db.get_default_human_author()
        with pytest.raises(ValueError, match="current default"):
            db.delete_author(human.id)

    def test_delete_author_succeeds_for_unreferenced_non_default(self, temp_db: Path) -> None:
        author = db.create_author("human", "Eve")
        db.delete_author(author.id)
        assert db.get_author_by_id(author.id) is None

    def test_set_default_author_repoints_default(self, temp_db: Path) -> None:
        new_human = db.create_author("human", "Frank")
        db.set_default_author(new_human.id)
        assert db.get_default_human_author().id == new_human.id
```

Note: `test_delete_author_refuses_referenced_author` calls `db.add_reply(comment_uuid, "a reply", author=author.name)` - this depends on Task 6's `add_reply` resolving an arbitrary registered name, not just `"me"`/`"claude"`. Task 6 must land before this specific test can pass; if run standalone against only Task 4's changes, this one test will fail until Task 6 is done (every other test in this class does not depend on Task 6).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/test_database.py::TestAuthors -v`
Expected: FAIL with `AttributeError: module 'claude_reviewer.database' has no attribute 'list_authors'`

- [ ] **Step 3: Write minimal implementation**

In `claude_reviewer/database.py`, update the `models` import (lines 38-47) to add `Author`:

```python
from .models import (
    Author,
    Comment,
    CommentReply,
    PRStatus,
    PullRequest,
    RepoConversation,
    RepoConversationMessage,
    RepoConversationStatus,
    ReviewAction,
)
```

Add `import` for the git helper near the top, after `from pathlib import Path` (line 35):

```python
from .git_ops import get_global_git_user
```

Replace the `comment_replies` table definition in `SCHEMA_SQL` (lines 127-135):

```sql
-- Comment replies table
CREATE TABLE IF NOT EXISTS comment_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

with:

```sql
-- Authors table (human + agent identities)
CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_authors_kind ON authors(kind);

-- Settings table (default-author pointers only, not a generic KV store)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Comment replies table
CREATE TABLE IF NOT EXISTS comment_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES authors(id),
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Replace the `repo_conversation_messages` table definition (lines 163-170):

```sql
-- Repo conversation messages
CREATE TABLE IF NOT EXISTS repo_conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    conversation_id INTEGER NOT NULL REFERENCES repo_conversations(id) ON DELETE CASCADE,
    author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

with:

```sql
-- Repo conversation messages
CREATE TABLE IF NOT EXISTS repo_conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    conversation_id INTEGER NOT NULL REFERENCES repo_conversations(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES authors(id),
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Replace `init_db` (lines 210-215):

```python
def init_db(db_path: Path | None = None) -> None:
    """Initialize database schema and apply any pending migrations."""
    with get_connection(db_path) as conn:
        _rebuild_reply_tables_if_pre_authors(conn)
        conn.executescript(SCHEMA_SQL)
        _seed_authors(conn)
        _migrate_comments_end_line(conn)
        _migrate_comments_commit_sha(conn)


def _rebuild_reply_tables_if_pre_authors(conn: sqlite3.Connection) -> None:
    """A database created before the authors table existed has
    comment_replies/repo_conversation_messages in the old author-TEXT-column
    shape. Rather than backfill (existing reply data is not preserved - see
    the design spec), drop and let SCHEMA_SQL recreate both tables in the
    new author_id-based shape.
    """
    authors_exists = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='authors'"
    ).fetchone()
    if not authors_exists:
        conn.execute("DROP TABLE IF EXISTS comment_replies")
        conn.execute("DROP TABLE IF EXISTS repo_conversation_messages")


def _seed_authors(conn: sqlite3.Connection) -> None:
    """Seeds the one-time default agent ('claude') and default human (from
    git config, if available) rows, plus the settings pointers to them.
    Guarded so it only inserts rows/pointers that don't exist yet - safe to
    call on every init_db() call.
    """
    agent_row = conn.execute("SELECT id FROM authors WHERE kind = 'agent'").fetchone()
    if agent_row:
        agent_id = agent_row["id"]
    else:
        cursor = conn.execute("INSERT INTO authors (kind, name) VALUES ('agent', 'claude')")
        agent_id = cursor.lastrowid

    human_row = conn.execute("SELECT id FROM authors WHERE kind = 'human'").fetchone()
    if human_row:
        human_id = human_row["id"]
    else:
        name, email = get_global_git_user()
        cursor = conn.execute(
            "INSERT INTO authors (kind, name, email) VALUES ('human', ?, ?)",
            (name or "reviewer", email),
        )
        human_id = cursor.lastrowid

    has_default_agent = conn.execute(
        "SELECT 1 FROM settings WHERE key = 'default_agent_author_id'"
    ).fetchone()
    if not has_default_agent:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('default_agent_author_id', ?)",
            (str(agent_id),),
        )

    has_default_human = conn.execute(
        "SELECT 1 FROM settings WHERE key = 'default_human_author_id'"
    ).fetchone()
    if not has_default_human:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('default_human_author_id', ?)",
            (str(human_id),),
        )
```

Add a `_row_to_author` helper near the other `_row_to_*` helpers (after `_row_to_comment`, after line 279):

```python
def _row_to_author(row: sqlite3.Row) -> Author:
    """Convert a database row to an Author object."""
    return Author(
        id=row["id"],
        kind=row["kind"],
        name=row["name"],
        email=row["email"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
```

Add the CRUD operations as a new section at the end of the file (after `get_unanswered_pr_comments`, after line 995):

```python
# =============================================================================
# Author Operations
# =============================================================================


def get_setting(key: str) -> str | None:
    """Get a setting value by key, or None if unset."""
    with get_connection() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_setting(key: str, value: str) -> None:
    """Upsert a setting value."""
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
            """,
            (key, value),
        )


def list_authors() -> list[Author]:
    """List all registered authors, ordered by kind then name."""
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM authors ORDER BY kind, name").fetchall()
        return [_row_to_author(row) for row in rows]


def get_author_by_id(author_id: int) -> Author | None:
    """Get an author by id."""
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        return _row_to_author(row) if row else None


def get_author_by_name(name: str) -> Author | None:
    """Get an author by name, case-insensitive."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM authors WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
        return _row_to_author(row) if row else None


def get_default_human_author() -> Author:
    """Get the current default human author. Raises if none is configured."""
    author_id = get_setting("default_human_author_id")
    author = get_author_by_id(int(author_id)) if author_id else None
    if not author:
        raise ValueError("No default human author configured")
    return author


def get_default_agent_author() -> Author:
    """Get the current default agent author. Raises if none is configured."""
    author_id = get_setting("default_agent_author_id")
    author = get_author_by_id(int(author_id)) if author_id else None
    if not author:
        raise ValueError("No default agent author configured")
    return author


def create_author(kind: str, name: str, email: str | None = None) -> Author:
    """Create a new author. Raises ValueError on a duplicate (case-insensitive) name."""
    with get_connection() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO authors (kind, name, email) VALUES (?, ?, ?)",
                (kind, name, email),
            )
            author_id = cursor.lastrowid
        except sqlite3.IntegrityError as e:
            if "UNIQUE constraint failed" in str(e):
                raise ValueError(f'An author named "{name}" already exists') from e
            raise
        row = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        return _row_to_author(row)


def update_author(author_id: int, name: str | None = None, email: str | None = None) -> Author:
    """Update an author's name/email. kind is never editable."""
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        if not existing:
            raise ValueError(f"Author {author_id} not found")

        new_name = name if name is not None else existing["name"]
        new_email = email if email is not None else existing["email"]

        try:
            conn.execute(
                "UPDATE authors SET name = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (new_name, new_email, author_id),
            )
        except sqlite3.IntegrityError as e:
            if "UNIQUE constraint failed" in str(e):
                raise ValueError(f'An author named "{new_name}" already exists') from e
            raise

        row = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        return _row_to_author(row)


def delete_author(author_id: int) -> None:
    """Delete an author. Raises ValueError if referenced by any reply/message
    or if it's the current default for its kind."""
    with get_connection() as conn:
        author_row = conn.execute("SELECT * FROM authors WHERE id = ?", (author_id,)).fetchone()
        if not author_row:
            raise ValueError(f"Author {author_id} not found")
        author = _row_to_author(author_row)

        reply_count = conn.execute(
            "SELECT COUNT(*) as count FROM comment_replies WHERE author_id = ?", (author_id,)
        ).fetchone()["count"]
        message_count = conn.execute(
            "SELECT COUNT(*) as count FROM repo_conversation_messages WHERE author_id = ?",
            (author_id,),
        ).fetchone()["count"]
        total_references = reply_count + message_count
        if total_references > 0:
            plural = "reply" if total_references == 1 else "replies"
            raise ValueError(f'Cannot delete "{author.name}" - referenced by {total_references} {plural}')

        default_key = "default_human_author_id" if author.kind == "human" else "default_agent_author_id"
        current_default = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (default_key,)
        ).fetchone()
        if current_default and current_default["value"] == str(author_id):
            raise ValueError(
                f'Cannot delete "{author.name}" - it\'s the current default {author.kind}. '
                "Set a different default first."
            )

        conn.execute("DELETE FROM authors WHERE id = ?", (author_id,))


def set_default_author(author_id: int) -> None:
    """Make this author the default for its kind."""
    author = get_author_by_id(author_id)
    if not author:
        raise ValueError(f"Author {author_id} not found")
    key = "default_human_author_id" if author.kind == "human" else "default_agent_author_id"
    set_setting(key, str(author_id))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/test_database.py -v`
Expected: PASS for every test in `TestAuthors` except `test_delete_author_refuses_referenced_author`, which stays failing until Task 6 rewires `add_reply`'s `author` parameter to accept an arbitrary registered name - `test_database.py` has no other pre-existing tests exercising `add_reply`/`add_repo_conversation_message`/`create_repo_conversation` today, so nothing else in this file regresses.

- [ ] **Step 5: Commit**

```bash
git add claude-reviewer-cli/claude_reviewer/database.py claude-reviewer-cli/claude_reviewer/models.py claude-reviewer-cli/tests/test_database.py
git commit -m "feat: add authors/settings schema, seeding, and CRUD (Python)"
```

---

## Task 5: Rewire comment-reply write/read path (TS)

**Files:**
- Modify: `lib/database.ts`
- Test: `__tests__/database.test.ts`

**Interfaces:**
- Consumes: `getDefaultHumanAuthor()`, `getAuthorById()` from Task 3.
- Produces: `CommentReply` interface gains `author_id: number` and `author_kind: AuthorKind`. `addReply(commentUuid: string, content: string): string` (no more `author` param). Consumed by Task 10 (API route) and Task 12 (frontend wiring).

- [ ] **Step 1: Write the failing test**

Add to `__tests__/database.test.ts`'s import list:

```ts
  addReply,
  getReplies,
  getCommentsWithReplies,
```

Add a new `describe` block after "Author Operations":

```ts
  describe("Comment Reply Operations", () => {
    let prUuid: string;
    let commentUuid: string;

    beforeAll(() => {
      prUuid = createPR("/repo/replies", "Reply Test PR", "main", "feature", "a", "b", "diff");
      commentUuid = addComment(prUuid, "file.py", 1, "a comment");
    });

    test("addReply always attributes to the default human author", () => {
      const replyUuid = addReply(commentUuid, "a reply");
      expect(replyUuid).toBeDefined();

      const replies = getReplies(commentUuid);
      const reply = replies.find((r) => r.uuid === replyUuid);
      expect(reply?.author).toBe(getDefaultHumanAuthor().name);
      expect(reply?.author_kind).toBe("human");
    });

    test("renaming the default human author retroactively updates past replies", () => {
      const replyUuid = addReply(commentUuid, "another reply");
      const human = getDefaultHumanAuthor();
      updateAuthor(human.id, { name: "Renamed Human" });

      const replies = getReplies(commentUuid);
      const reply = replies.find((r) => r.uuid === replyUuid);
      expect(reply?.author).toBe("Renamed Human");
    });

    test("getCommentsWithReplies includes author_kind on each reply", () => {
      const withReplies = getCommentsWithReplies(prUuid);
      const target = withReplies.find((c) => c.comment.uuid === commentUuid);
      expect(target?.replies.every((r) => r.author_kind === "human")).toBe(true);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run __tests__/database.test.ts`
Expected: FAIL - `addReply` still requires resolving against the old `author TEXT` column shape, which no longer exists after Task 3; `reply?.author_kind` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `lib/database.ts`, update the `CommentReply` interface (lines 53-60):

```ts
export interface CommentReply {
  id: number;
  uuid: string;
  comment_id: number;
  author_id: number;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}
```

Replace `addReply` (lines 574-599):

```ts
export function addReply(commentUuid: string, content: string): string {
  const db = getDatabase();
  const replyUuid = generateUuid();
  const authorId = getDefaultHumanAuthor().id;

  const comment = db.prepare('SELECT id, pr_id FROM comments WHERE uuid = ?').get(commentUuid) as { id: number; pr_id: number } | undefined;
  if (!comment) throw new Error(`Comment ${commentUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO comment_replies (uuid, comment_id, author_id, content)
      VALUES (?, ?, ?, ?)
    `).run(replyUuid, comment.id, authorId, content);

    db.prepare(
      'UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(comment.pr_id);
  });

  transaction();
  checkpoint();
  return replyUuid;
}
```

Replace `getReplies` (lines 601-610):

```ts
export function getReplies(commentUuid: string): CommentReply[] {
  const db = getDatabase();

  const comment = db.prepare('SELECT id FROM comments WHERE uuid = ?').get(commentUuid) as { id: number } | undefined;
  if (!comment) return [];

  return db.prepare(`
    SELECT cr.id, cr.uuid, cr.comment_id, cr.author_id, a.name AS author, a.kind AS author_kind, cr.content, cr.created_at
    FROM comment_replies cr
    JOIN authors a ON a.id = cr.author_id
    WHERE cr.comment_id = ?
    ORDER BY cr.created_at
  `).all(comment.id) as CommentReply[];
}
```

`getCommentsWithReplies` (lines 618-624) is unchanged - it just calls `getReplies`, so it inherits the new shape automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run __tests__/database.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add lib/database.ts __tests__/database.test.ts
git commit -m "feat: rewire comment-reply write/read path onto authors table (TS)"
```

---

## Task 6: Rewire comment-reply write/read path (Python)

**Files:**
- Modify: `claude-reviewer-cli/claude_reviewer/database.py`
- Modify: `claude-reviewer-cli/claude_reviewer/models.py`
- Test: `claude-reviewer-cli/tests/test_database.py`

**Interfaces:**
- Consumes: `get_default_human_author()`, `get_default_agent_author()`, `get_author_by_name()` from Task 4.
- Produces: `CommentReply` dataclass gains `author_id: int` and `author_kind: str`. `add_reply(comment_uuid: str, content: str, author: str = "claude") -> str` resolves `"me"`/`"claude"`/an exact registered name, raising `ValueError` for anything else. Consumed by Task 15 (CLI).

- [ ] **Step 1: Write the failing test**

Add to `claude-reviewer-cli/tests/test_database.py`, inside a new test class (add after `TestAuthors`):

```python
class TestCommentReplies:
    """Tests for comment reply operations."""

    def test_add_reply_me_sentinel_resolves_to_default_human(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")

        db.add_reply(comment_uuid, "a reply", author="me")
        replies = db.get_replies(comment_uuid)
        assert replies[0].author == db.get_default_human_author().name
        assert replies[0].author_kind == "human"

    def test_add_reply_claude_sentinel_resolves_to_default_agent(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")

        db.add_reply(comment_uuid, "a reply", author="claude")
        replies = db.get_replies(comment_uuid)
        assert replies[0].author == "claude"
        assert replies[0].author_kind == "agent"

    def test_add_reply_registered_name_resolves_directly(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")
        db.create_author("human", "Guest Reviewer")

        db.add_reply(comment_uuid, "a reply", author="Guest Reviewer")
        replies = db.get_replies(comment_uuid)
        assert replies[0].author == "Guest Reviewer"

    def test_add_reply_unregistered_name_raises(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")

        with pytest.raises(ValueError, match="Unknown author"):
            db.add_reply(comment_uuid, "a reply", author="Nobody Registered")

    def test_renaming_default_human_retroactively_updates_replies(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")
        db.add_reply(comment_uuid, "a reply", author="me")

        human = db.get_default_human_author()
        db.update_author(human.id, name="Renamed Human")

        replies = db.get_replies(comment_uuid)
        assert replies[0].author == "Renamed Human"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/test_database.py::TestCommentReplies -v`
Expected: FAIL - `add_reply` still inserts into the old `author TEXT` column shape (which no longer exists after Task 4), or `replies[0].author_kind` raises `AttributeError`.

- [ ] **Step 3: Write minimal implementation**

Update the `CommentReply` dataclass in `models.py` (lines 73-80):

```python
@dataclass
class CommentReply:
    id: int
    uuid: str
    comment_id: int
    author_id: int
    author: str
    author_kind: str  # "human" | "agent"
    content: str
    created_at: Optional[datetime] = None
```

Add a private resolver in `database.py`, just before `add_reply` (before line 641):

```python
def _resolve_author_id(author: str) -> int:
    """Resolve a CLI --author value (or an internal call's literal) to an
    author_id. "me" and "claude" are pointer-based sentinels; anything else
    must be an exact (case-insensitive) registered author name."""
    if author == "me":
        return get_default_human_author().id
    if author == "claude":
        return get_default_agent_author().id
    found = get_author_by_name(author)
    if not found:
        raise ValueError(
            f"Unknown author '{author}'. Run 'claude-reviewer authors list' to see "
            "registered authors, or 'claude-reviewer authors add' to register a new one."
        )
    return found.id
```

Replace `_row_to_reply` (lines 629-638):

```python
def _row_to_reply(row: sqlite3.Row) -> CommentReply:
    """Convert a database row to a CommentReply object."""
    return CommentReply(
        id=row["id"],
        uuid=row["uuid"],
        comment_id=row["comment_id"],
        author_id=row["author_id"],
        author=row["author"],
        author_kind=row["author_kind"],
        content=row["content"],
        created_at=row["created_at"],
    )
```

Replace `add_reply` (lines 641-672):

```python
def add_reply(
    comment_uuid: str,
    content: str,
    author: str = "claude",
) -> str:
    """Add a reply to a comment and return its UUID."""
    reply_uuid = generate_uuid()
    author_id = _resolve_author_id(author)

    with get_connection() as conn:
        comment = conn.execute(
            "SELECT id, pr_id FROM comments WHERE uuid = ?",
            (comment_uuid,),
        ).fetchone()

        if not comment:
            raise ValueError(f"Comment {comment_uuid} not found")

        conn.execute(
            """
            INSERT INTO comment_replies (uuid, comment_id, author_id, content)
            VALUES (?, ?, ?, ?)
            """,
            (reply_uuid, comment["id"], author_id, content),
        )

        conn.execute(
            "UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (comment["pr_id"],),
        )

    return reply_uuid
```

Replace `get_replies` (lines 675-693):

```python
def get_replies(comment_uuid: str) -> list[CommentReply]:
    """Get all replies for a comment."""
    with get_connection() as conn:
        comment = conn.execute(
            "SELECT id FROM comments WHERE uuid = ?",
            (comment_uuid,),
        ).fetchone()

        if not comment:
            return []

        rows = conn.execute(
            """
            SELECT cr.id, cr.uuid, cr.comment_id, cr.author_id,
                   a.name AS author, a.kind AS author_kind, cr.content, cr.created_at
            FROM comment_replies cr
            JOIN authors a ON a.id = cr.author_id
            WHERE cr.comment_id = ? ORDER BY cr.created_at
            """,
            (comment["id"],),
        ).fetchall()

        return [_row_to_reply(row) for row in rows]
```

Update `get_unanswered_pr_comments` (lines 991): change

```python
            if not replies or replies[-1].author != "claude":
```

to:

```python
            if not replies or replies[-1].author_kind != "agent":
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/test_database.py -v`
Expected: PASS (all tests, including the previously-deferred `TestAuthors::test_delete_author_refuses_referenced_author`)

- [ ] **Step 5: Commit**

```bash
git add claude-reviewer-cli/claude_reviewer/database.py claude-reviewer-cli/claude_reviewer/models.py claude-reviewer-cli/tests/test_database.py
git commit -m "feat: rewire comment-reply write/read path onto authors table (Python)"
```

---

## Task 7: Rewire repo-conversation write/read path (TS)

**Files:**
- Modify: `lib/database.ts`
- Test: `__tests__/database.test.ts`

**Interfaces:**
- Consumes: `getDefaultHumanAuthor()`, `getDefaultAgentAuthor()` from Task 3.
- Produces: `RepoConversationMessage` gains `author_id: number` and `author_kind: AuthorKind`. `createRepoConversation(repoPath, filePath, lineNumber, content, authorHint?: 'human' | 'claude', anchor?)` and `addRepoConversationMessage(conversationUuid, content, authorHint?: 'human' | 'claude')` - `authorHint` defaults to `'human'`. Consumed by Task 10 (API routes) and Task 13/14 (frontend wiring); `app/api/claude/route.ts` already passes the literal `'claude'` and needs no changes.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/database.test.ts`'s import list:

```ts
  createRepoConversation,
  addRepoConversationMessage,
  listRepoConversations,
  getRepoConversationWithMessages,
```

Add a new `describe` block after "Comment Reply Operations":

```ts
  describe("Repo Conversation Operations", () => {
    test("createRepoConversation defaults to the default human author", () => {
      const convUuid = createRepoConversation("/repo/conv", "file.py", 10, "first message");
      const withMessages = getRepoConversationWithMessages(convUuid);
      expect(withMessages?.messages[0].author).toBe(getDefaultHumanAuthor().name);
      expect(withMessages?.messages[0].author_kind).toBe("human");
    });

    test("createRepoConversation with 'claude' hint attributes to the default agent", () => {
      const convUuid = createRepoConversation("/repo/conv", "file2.py", 5, "claude's opening", "claude");
      const withMessages = getRepoConversationWithMessages(convUuid);
      expect(withMessages?.messages[0].author).toBe("claude");
      expect(withMessages?.messages[0].author_kind).toBe("agent");
    });

    test("addRepoConversationMessage with 'claude' hint attributes to the default agent", () => {
      const convUuid = createRepoConversation("/repo/conv", "file3.py", 1, "human message");
      addRepoConversationMessage(convUuid, "claude's reply", "claude");

      const withMessages = getRepoConversationWithMessages(convUuid);
      expect(withMessages?.messages[1].author).toBe("claude");
      expect(withMessages?.messages[1].author_kind).toBe("agent");
    });

    test("listRepoConversations includes author_kind on each message", () => {
      createRepoConversation("/repo/conv-list", "file.py", 1, "a message");
      const list = listRepoConversations({ repoPath: "/repo/conv-list" });
      expect(list[0].messages[0].author_kind).toBe("human");
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run __tests__/database.test.ts`
Expected: FAIL - `createRepoConversation`'s current `author: string = 'user'` parameter still expects a raw string written to the (now-removed) `author` column.

- [ ] **Step 3: Write minimal implementation**

Update the `RepoConversationMessage` interface (lines 80-87):

```ts
export interface RepoConversationMessage {
  id: number;
  uuid: string;
  conversation_id: number;
  author_id: number;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}
```

Replace `createRepoConversation` (lines 630-678):

```ts
export function createRepoConversation(
  repoPath: string,
  filePath: string,
  lineNumber: number,
  content: string,
  authorHint: 'human' | 'claude' = 'human',
  anchor?: {
    content: string;
    contextBefore: string;
    contextAfter: string;
    commit: string;
  }
): string {
  const db = getDatabase();
  const conversationUuid = generateUuid();
  const messageUuid = generateUuid();
  const authorId = (authorHint === 'claude' ? getDefaultAgentAuthor() : getDefaultHumanAuthor()).id;

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO repo_conversations
      (uuid, repo_path, file_path, line_number, anchor_content, anchor_context_before, anchor_context_after, anchor_commit, current_line_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationUuid,
      repoPath,
      filePath,
      lineNumber,
      anchor?.content || null,
      anchor?.contextBefore || null,
      anchor?.contextAfter || null,
      anchor?.commit || null,
      lineNumber
    );

    const conv = db.prepare('SELECT id FROM repo_conversations WHERE uuid = ?').get(conversationUuid) as { id: number };

    db.prepare(`
      INSERT INTO repo_conversation_messages (uuid, conversation_id, author_id, content)
      VALUES (?, ?, ?, ?)
    `).run(messageUuid, conv.id, authorId, content);
  });

  transaction();
  checkpoint();
  return conversationUuid;
}
```

Replace `addRepoConversationMessage` (lines 746-771):

```ts
export function addRepoConversationMessage(
  conversationUuid: string,
  content: string,
  authorHint: 'human' | 'claude' = 'human'
): string {
  const db = getDatabase();
  const messageUuid = generateUuid();
  const authorId = (authorHint === 'claude' ? getDefaultAgentAuthor() : getDefaultHumanAuthor()).id;

  const conv = db.prepare('SELECT id FROM repo_conversations WHERE uuid = ?').get(conversationUuid) as { id: number } | undefined;
  if (!conv) throw new Error(`Conversation ${conversationUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO repo_conversation_messages (uuid, conversation_id, author_id, content)
      VALUES (?, ?, ?, ?)
    `).run(messageUuid, conv.id, authorId, content);

    db.prepare(`
      UPDATE repo_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(conv.id);
  });

  transaction();
  checkpoint();
  return messageUuid;
}
```

Replace the messages subquery inside `listRepoConversations` (lines 714-718):

```ts
    const messages = db.prepare(`
      SELECT rcm.id, rcm.uuid, rcm.conversation_id, rcm.author_id, a.name AS author, a.kind AS author_kind, rcm.content, rcm.created_at
      FROM repo_conversation_messages rcm
      JOIN authors a ON a.id = rcm.author_id
      WHERE rcm.conversation_id = ?
      ORDER BY rcm.created_at ASC
    `).all(conv.id) as RepoConversationMessage[];
```

Replace the messages query inside `getRepoConversationWithMessages` (lines 733-737):

```ts
  const messages = db.prepare(`
    SELECT rcm.id, rcm.uuid, rcm.conversation_id, rcm.author_id, a.name AS author, a.kind AS author_kind, rcm.content, rcm.created_at
    FROM repo_conversation_messages rcm
    JOIN authors a ON a.id = rcm.author_id
    WHERE rcm.conversation_id = ?
    ORDER BY rcm.created_at ASC
  `).all(conv.id) as RepoConversationMessage[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run __tests__/database.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add lib/database.ts __tests__/database.test.ts
git commit -m "feat: rewire repo-conversation write/read path onto authors table (TS)"
```

---

## Task 8: Rewire repo-conversation write/read path (Python)

**Files:**
- Modify: `claude-reviewer-cli/claude_reviewer/database.py`
- Modify: `claude-reviewer-cli/claude_reviewer/models.py`
- Modify: `claude-reviewer-cli/claude_reviewer/cli.py`
- Test: `claude-reviewer-cli/tests/test_database.py`

**Interfaces:**
- Consumes: `get_default_human_author()`, `get_default_agent_author()` from Task 4.
- Produces: `RepoConversationMessage` gains `author_id: int` and `author_kind: str`. `create_repo_conversation(..., author: str = "user", ...)` and `add_repo_conversation_message(conv_uuid, content, author: str = "user")` resolve `"claude"` to the default agent and anything else to the default human. `get_unanswered_conversations` uses `author_kind` instead of the literal string check.

- [ ] **Step 1: Write the failing test**

Add to `claude-reviewer-cli/tests/test_database.py`, a new test class:

```python
class TestRepoConversations:
    """Tests for repo conversation operations."""

    def test_create_repo_conversation_defaults_to_default_human(self, temp_db: Path) -> None:
        conv_uuid = db.create_repo_conversation("/repo", "file.py", 10, "first message")
        messages = db.get_repo_conversation_messages(conv_uuid)
        assert messages[0].author == db.get_default_human_author().name
        assert messages[0].author_kind == "human"

    def test_create_repo_conversation_claude_author_attributes_to_agent(self, temp_db: Path) -> None:
        conv_uuid = db.create_repo_conversation("/repo", "file2.py", 5, "claude's message", author="claude")
        messages = db.get_repo_conversation_messages(conv_uuid)
        assert messages[0].author == "claude"
        assert messages[0].author_kind == "agent"

    def test_add_repo_conversation_message_claude_attributes_to_agent(self, temp_db: Path) -> None:
        conv_uuid = db.create_repo_conversation("/repo", "file3.py", 1, "human message")
        db.add_repo_conversation_message(conv_uuid, "claude's reply", author="claude")

        messages = db.get_repo_conversation_messages(conv_uuid)
        assert messages[1].author == "claude"
        assert messages[1].author_kind == "agent"

    def test_get_unanswered_conversations_uses_author_kind(self, temp_db: Path) -> None:
        conv_uuid = db.create_repo_conversation("/repo/unanswered", "file.py", 1, "a question")
        unanswered = db.get_unanswered_conversations("/repo/unanswered")
        assert any(c.uuid == conv_uuid for c, _msgs in unanswered)

        db.add_repo_conversation_message(conv_uuid, "an answer", author="claude")
        unanswered_after = db.get_unanswered_conversations("/repo/unanswered")
        assert not any(c.uuid == conv_uuid for c, _msgs in unanswered_after)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/test_database.py::TestRepoConversations -v`
Expected: FAIL - `create_repo_conversation` still writes to the removed `author` TEXT column.

- [ ] **Step 3: Write minimal implementation**

Update the `RepoConversationMessage` dataclass in `models.py` (lines 109-118):

```python
@dataclass
class RepoConversationMessage:
    """A message within a repo conversation thread."""

    id: int
    uuid: str
    conversation_id: int
    author_id: int
    author: str
    author_kind: str  # "human" | "agent"
    content: str
    created_at: Optional[datetime] = None
```

Add a resolver for the `"user"`/`"claude"` hint convention used by the repo-conversation functions, just before `create_repo_conversation` in `database.py` (before line 759):

```python
def _resolve_message_author_id(author_hint: str) -> int:
    """Resolve the repo-conversation author hint: 'claude' attributes to the
    default agent, anything else (including the historical default 'user')
    attributes to the default human."""
    if author_hint == "claude":
        return get_default_agent_author().id
    return get_default_human_author().id
```

Replace `_row_to_repo_message` (lines 747-756):

```python
def _row_to_repo_message(row: sqlite3.Row) -> RepoConversationMessage:
    """Convert a database row to a RepoConversationMessage object."""
    return RepoConversationMessage(
        id=row["id"],
        uuid=row["uuid"],
        conversation_id=row["conversation_id"],
        author_id=row["author_id"],
        author=row["author"],
        author_kind=row["author_kind"],
        content=row["content"],
        created_at=row["created_at"],
    )
```

Replace `create_repo_conversation` (lines 759-805):

```python
def create_repo_conversation(
    repo_path: str,
    file_path: str,
    line_number: int,
    content: str,
    author: str = "user",
    anchor_content: str | None = None,
    anchor_context_before: str | None = None,
    anchor_context_after: str | None = None,
    anchor_commit: str | None = None,
) -> str:
    """Create a new repo conversation with initial message and return its UUID."""
    conv_uuid = generate_uuid()
    msg_uuid = generate_uuid()
    author_id = _resolve_message_author_id(author)

    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO repo_conversations
            (uuid, repo_path, file_path, line_number, anchor_content,
             anchor_context_before, anchor_context_after, anchor_commit, current_line_number)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                conv_uuid,
                repo_path,
                file_path,
                line_number,
                anchor_content,
                anchor_context_before,
                anchor_context_after,
                anchor_commit,
                line_number,
            ),
        )
        conv_id = cursor.lastrowid

        conn.execute(
            """
            INSERT INTO repo_conversation_messages (uuid, conversation_id, author_id, content)
            VALUES (?, ?, ?, ?)
            """,
            (msg_uuid, conv_id, author_id, content),
        )

    return conv_uuid
```

Replace `add_repo_conversation_message` (lines 890-921):

```python
def add_repo_conversation_message(
    conv_uuid: str,
    content: str,
    author: str = "user",
) -> str:
    """Add a message to a repo conversation and return its UUID."""
    msg_uuid = generate_uuid()
    author_id = _resolve_message_author_id(author)

    with get_connection() as conn:
        conv = conn.execute(
            "SELECT id FROM repo_conversations WHERE uuid = ?",
            (conv_uuid,),
        ).fetchone()

        if not conv:
            raise ValueError(f"Conversation {conv_uuid} not found")

        conn.execute(
            """
            INSERT INTO repo_conversation_messages (uuid, conversation_id, author_id, content)
            VALUES (?, ?, ?, ?)
            """,
            (msg_uuid, conv["id"], author_id, content),
        )

        conn.execute(
            "UPDATE repo_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (conv["id"],),
        )

    return msg_uuid
```

Replace `get_repo_conversation_messages`'s query (lines 924-943):

```python
def get_repo_conversation_messages(conv_uuid: str) -> list[RepoConversationMessage]:
    """Get all messages for a repo conversation."""
    with get_connection() as conn:
        conv = conn.execute(
            "SELECT id FROM repo_conversations WHERE uuid = ?",
            (conv_uuid,),
        ).fetchone()

        if not conv:
            return []

        rows = conn.execute(
            """
            SELECT rcm.id, rcm.uuid, rcm.conversation_id, rcm.author_id,
                   a.name AS author, a.kind AS author_kind, rcm.content, rcm.created_at
            FROM repo_conversation_messages rcm
            JOIN authors a ON a.id = rcm.author_id
            WHERE rcm.conversation_id = ? ORDER BY rcm.created_at
            """,
            (conv["id"],),
        ).fetchall()

        return [_row_to_repo_message(row) for row in rows]
```

Update `get_unanswered_conversations` (line 966): change

```python
        if messages and messages[-1].author != "claude":
```

to:

```python
        if messages and messages[-1].author_kind != "agent":
```

In `claude_reviewer/cli.py`, no changes are needed for `respond_to_conversation`'s call at line 1449 (`db.add_repo_conversation_message(conv.uuid, response, author="claude")`) or `respond_to_pr_comment`'s call at line 1574 (`db.add_reply(comment.uuid, response, author="claude")`) - both already pass the literal `"claude"`, which `_resolve_message_author_id`/`_resolve_author_id` (Task 6) both handle as the default-agent sentinel. (Line numbers reflect this branch's current rebase onto `main`, which added several commands - `serve --check`, `open`, `skills` - ahead of these call sites; re-grep for `author="claude"` if they've drifted further by the time this task runs.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/ -v`
Expected: PASS (the full suite, including `test_cli.py`'s existing tests, which exercise `respond_to_pr_comment`/`respond_to_conversation` indirectly)

- [ ] **Step 5: Commit**

```bash
git add claude-reviewer-cli/claude_reviewer/database.py claude-reviewer-cli/claude_reviewer/models.py claude-reviewer-cli/tests/test_database.py
git commit -m "feat: rewire repo-conversation write/read path onto authors table (Python)"
```

---

## Task 9: Web API — authors CRUD routes

**Files:**
- Create: `app/api/authors/route.ts`
- Create: `app/api/authors/[id]/route.ts`
- Create: `app/api/authors/[id]/default/route.ts`

**Interfaces:**
- Consumes: `listAuthors`, `getAuthorById`, `getDefaultHumanAuthor`, `getDefaultAgentAuthor`, `createAuthor`, `updateAuthor`, `deleteAuthor`, `setDefaultAuthor` from `lib/database.ts` (Task 3); `getGitUserIdentity` from `lib/git.ts` (Task 1).
- Produces: `GET /api/authors` → `{ authors: Array<Author & { isDefaultHuman: boolean; isDefaultAgent: boolean }>, gitSuggestion: { name: string | null; email: string | null } | null }`; `POST /api/authors` → `{ author: Author }` (201); `PATCH /api/authors/[id]` → `{ author: Author }`; `DELETE /api/authors/[id]` → `{ success: true }` or 409; `POST /api/authors/[id]/default` → `{ success: true }`. Consumed by Task 11 (settings page) and Task 12 (PR page's optimistic-name fetch).

This task has no dedicated test file (no page-level/route-level test precedent exists in this codebase yet - the closest is `__tests__/database.test.ts` testing the underlying `lib/database.ts` functions directly, which Tasks 3/5/7 already cover). Verification for this task is the manual pass in Task 11, once the settings page can exercise these routes end-to-end.

- [ ] **Step 1: Create the collection route**

Create `app/api/authors/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { listAuthors, getDefaultHumanAuthor, getDefaultAgentAuthor, createAuthor } from '@/lib/database';
import { getGitUserIdentity } from '@/lib/git';

// GET /api/authors - List all authors, annotated with default status
export async function GET() {
  try {
    const authors = listAuthors();
    const defaultHuman = getDefaultHumanAuthor();
    const defaultAgent = getDefaultAgentAuthor();
    const gitIdentity = getGitUserIdentity();

    return NextResponse.json({
      authors: authors.map((a) => ({
        ...a,
        isDefaultHuman: a.id === defaultHuman.id,
        isDefaultAgent: a.id === defaultAgent.id,
      })),
      gitSuggestion: gitIdentity.name || gitIdentity.email ? gitIdentity : null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/authors - Register a new author
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, kind, email } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (kind !== 'human' && kind !== 'agent') {
      return NextResponse.json({ error: "kind must be 'human' or 'agent'" }, { status: 400 });
    }

    const author = createAuthor(kind, name.trim(), email || null);
    return NextResponse.json({ author }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 2: Create the by-id route**

Create `app/api/authors/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { updateAuthor, deleteAuthor } from '@/lib/database';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// PATCH /api/authors/[id] - Update name/email
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await req.json();
    const author = updateAuthor(Number(id), { name: body.name, email: body.email });
    return NextResponse.json({ author });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE /api/authors/[id] - Remove an author (blocked if referenced or default)
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    deleteAuthor(Number(id));
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
```

- [ ] **Step 3: Create the set-default route**

Create `app/api/authors/[id]/default/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { setDefaultAuthor } from '@/lib/database';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/authors/[id]/default - Make this author the default for its kind
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    setDefaultAuthor(Number(id));
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add app/api/authors
git commit -m "feat: add /api/authors CRUD routes"
```

---

## Task 10: Web API — drop client-supplied author from reply/comment routes

**Files:**
- Modify: `app/api/prs/[id]/comments/route.ts`
- Modify: `app/api/browse/conversations/route.ts`
- Modify: `app/api/browse/conversations/[id]/messages/route.ts`

**Interfaces:**
- Consumes: `addReply(commentUuid, content)` (Task 5), `createRepoConversation(..., authorHint?)`, `addRepoConversationMessage(..., authorHint?)` (Task 7).
- Produces: these three routes no longer accept or forward a client-supplied `author` field - authorship is always server-resolved to the default human. Consumed by Task 12/13/14's frontend wiring (which stop sending `author` in their POST bodies).

- [ ] **Step 1: Update the PR-comments route**

In `app/api/prs/[id]/comments/route.ts`, change the `POST` handler (lines 30-54). Change:

```ts
    const { filePath, lineNumber, endLineNumber, content, lineType, commentUuid, author, commitSha } = body;
```

to:

```ts
    const { filePath, lineNumber, endLineNumber, content, lineType, commentUuid, commitSha } = body;
```

and change:

```ts
      const replyUuid = addReply(commentUuid, content, author || 'user');
```

to:

```ts
      const replyUuid = addReply(commentUuid, content);
```

- [ ] **Step 2: Update the browse/conversations collection route**

In `app/api/browse/conversations/route.ts`, change the `POST` handler (lines 39-117). Change:

```ts
    const { repo, filePath, lineNumber, content, author = 'user' } = body;
```

to:

```ts
    const { repo, filePath, lineNumber, content } = body;
```

and change the `createRepoConversation` call (lines 110-117):

```ts
    const uuid = createRepoConversation(
      repo,
      filePath,
      lineNumber,
      content,
      author,
      anchor
    );
```

to:

```ts
    const uuid = createRepoConversation(
      repo,
      filePath,
      lineNumber,
      content,
      'human',
      anchor
    );
```

- [ ] **Step 3: Update the browse/conversations messages route**

In `app/api/browse/conversations/[id]/messages/route.ts`, change the `POST` handler (lines 29-45). Change:

```ts
    const { content, author = 'user' } = body;
```

to:

```ts
    const { content } = body;
```

and change:

```ts
    const messageUuid = addRepoConversationMessage(id, content, author);
```

to:

```ts
    const messageUuid = addRepoConversationMessage(id, content, 'human');
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add app/api/prs/\[id\]/comments/route.ts app/api/browse/conversations/route.ts app/api/browse/conversations/\[id\]/messages/route.ts
git commit -m "fix: stop accepting client-supplied author on reply/comment routes"
```

---

## Task 11: Settings page and nav link

**Files:**
- Create: `app/settings/page.tsx`
- Modify: `components/HeaderNav.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/authors`, `PATCH/DELETE /api/authors/[id]`, `POST /api/authors/[id]/default` (Task 9).
- Produces: a `/settings` route with a full Authors roster UI (list, add, inline edit, delete, make-default), linked from the header nav.

- [ ] **Step 1: Add the nav link**

In `components/HeaderNav.tsx`, add `Settings` to the `lucide-react` import (line 5):

```ts
import { GitPullRequest, FolderTree, MessageSquare, Settings } from 'lucide-react';
```

Add the `isActive` handling for `/settings` inside the `isActive` function (after the `/browse` check, before the final `return`):

```ts
    if (path === '/settings') {
      return pathname.startsWith('/settings');
    }
```

Add the nav link itself, after the "Conversations" `Link` (after line 42, before the closing `</nav>`):

```tsx
      <Link
        href="/settings"
        className={`nav-tab ${isActive('/settings') ? 'active' : ''}`}
      >
        <Settings size={16} />
        Settings
      </Link>
```

- [ ] **Step 2: Create the settings page**

Create `app/settings/page.tsx`:

```tsx
'use client';

import { useState, useEffect } from 'react';
import { Trash2, Star, Pencil } from 'lucide-react';

interface Author {
  id: number;
  kind: AuthorKind;
  name: string;
  email: string | null;
  isDefaultHuman: boolean;
  isDefaultAgent: boolean;
}

interface GitSuggestion {
  name: string | null;
  email: string | null;
}

export default function SettingsPage() {
  const [authors, setAuthors] = useState<Author[]>([]);
  const [gitSuggestion, setGitSuggestion] = useState<GitSuggestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');

  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<AuthorKind>('human');
  const [newEmail, setNewEmail] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/authors');
      if (!res.ok) throw new Error('Failed to load authors');
      const data = await res.json();
      setAuthors(data.authors);
      setGitSuggestion(data.gitSuggestion);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading authors');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const startEdit = (author: Author) => {
    setEditingId(author.id);
    setEditName(author.name);
    setEditEmail(author.email || '');
  };

  const applyGitSuggestion = () => {
    if (!gitSuggestion) return;
    setEditName(gitSuggestion.name || '');
    setEditEmail(gitSuggestion.email || '');
  };

  const saveEdit = async (id: number) => {
    try {
      const res = await fetch(`/api/authors/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), email: editEmail.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update author');
      setEditingId(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error updating author');
    }
  };

  const deleteAuthor = async (id: number) => {
    if (!confirm('Delete this author?')) return;
    try {
      const res = await fetch(`/api/authors/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete author');
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error deleting author');
    }
  };

  const makeDefault = async (id: number) => {
    try {
      const res = await fetch(`/api/authors/${id}/default`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to set default');
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error setting default');
    }
  };

  const addAuthor = async () => {
    if (!newName.trim()) return;
    try {
      const res = await fetch('/api/authors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), kind: newKind, email: newEmail.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add author');
      setNewName('');
      setNewEmail('');
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error adding author');
    }
  };

  if (loading) return <div className="settings-page"><p>Loading...</p></div>;

  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <section className="authors-section">
        <h2>Authors</h2>
        {error && <p className="error-text">{error}</p>}
        <table className="authors-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Email</th>
              <th>Default</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {authors.map((author) => {
              const isDefault = author.kind === 'human' ? author.isDefaultHuman : author.isDefaultAgent;
              const showGitHint =
                isDefault &&
                author.kind === 'human' &&
                gitSuggestion &&
                (gitSuggestion.name !== author.name || (gitSuggestion.email || null) !== author.email);

              return (
                <tr key={author.id}>
                  <td>{author.kind}</td>
                  <td>
                    {editingId === author.id ? (
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                    ) : (
                      author.name
                    )}
                  </td>
                  <td>
                    {editingId === author.id ? (
                      <input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
                    ) : (
                      author.email || <span className="dim">-</span>
                    )}
                  </td>
                  <td>{isDefault && <span className="default-badge">default</span>}</td>
                  <td className="actions-cell">
                    {editingId === author.id ? (
                      <>
                        {showGitHint && (
                          <button onClick={applyGitSuggestion} className="hint-btn">
                            git config says &quot;{gitSuggestion?.name}&quot; - use this?
                          </button>
                        )}
                        <button onClick={() => saveEdit(author.id)}>Save</button>
                        <button onClick={() => setEditingId(null)} className="cancel">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => startEdit(author)} title="Edit">
                          <Pencil size={14} />
                        </button>
                        {!isDefault && (
                          <button onClick={() => makeDefault(author.id)} title="Make default">
                            <Star size={14} />
                          </button>
                        )}
                        <button onClick={() => deleteAuthor(author.id)} className="delete-btn" title="Delete">
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="add-author-form">
          <input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as AuthorKind)}>
            <option value="human">human</option>
            <option value="agent">agent</option>
          </select>
          <input placeholder="Email (optional)" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          <button onClick={addAuthor} className="primary">Add Author</button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Manual verification**

Run: `npm run build && npm run start`, then visit `http://localhost:3000/settings`:
- Confirm the "Settings" nav link appears and is highlighted when on `/settings`.
- Confirm the Authors table lists a `human` row and an `agent` row named `claude`, both badged "default".
- With your machine's `git config user.name` set to something different from the human row's stored name, click Edit on the human row and confirm the "git config says..." hint button appears and fills the fields correctly when clicked.
- Add a new human author via the form; confirm it appears in the table without a default badge.
- Click the star icon on the new author to make it default; confirm the badge moves.
- Try deleting the (now non-default) original human author; if it has no replies, confirm it deletes successfully. Try deleting the new default; confirm it's refused with a clear error.

- [ ] **Step 5: Commit**

```bash
git add app/settings components/HeaderNav.tsx
git commit -m "feat: add settings page with authors roster management"
```

---

## Task 12: Frontend wiring — PR comment replies

**Files:**
- Modify: `app/prs/[id]/page.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `GET /api/authors` (Task 9); the rewired `POST /api/prs/[id]/comments` (Task 10).

- [ ] **Step 1: Add author_kind to the local CommentReply interface**

In `app/prs/[id]/page.tsx`, update the local `CommentReply` interface (lines 84-90):

```ts
interface CommentReply {
  id: number;
  uuid: string;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}
```

- [ ] **Step 2: Fetch the default human author's name on mount**

Add a new state variable near the other `useState` declarations (after line 236, `const [replyContent, setReplyContent] = useState('');`):

```ts
  const [defaultAuthorName, setDefaultAuthorName] = useState('reviewer');
```

Add a new `useEffect` after the existing data-fetching `useEffect` (after line 373, the one that calls `fetchPR()`):

```ts
  useEffect(() => {
    fetch('/api/authors')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const defaultHuman = data?.authors?.find((a: { isDefaultHuman: boolean; name: string }) => a.isDefaultHuman);
        if (defaultHuman) setDefaultAuthorName(defaultHuman.name);
      })
      .catch(() => {
        // Keep the "reviewer" fallback - replying must never be blocked by this.
      });
  }, []);
```

- [ ] **Step 3: Stop hardcoding 'ben' in addReply**

In `addReply` (lines 560-628), change the `tempReply` construction (lines 563-569):

```ts
    const tempReply: CommentReply = {
      id: Date.now(),
      uuid: `temp-${Date.now()}`,
      author: defaultAuthorName,
      author_kind: 'human',
      content: replyContent,
      created_at: new Date().toISOString(),
    };
```

and change the POST body (lines 587-591) from:

```ts
        body: JSON.stringify({
          commentUuid,
          content: replyContent,
          author: 'ben',
        }),
```

to:

```ts
        body: JSON.stringify({
          commentUuid,
          content: replyContent,
        }),
```

- [ ] **Step 4: Switch the CSS class ternary from a literal check to author_kind**

Change line 1315 from:

```tsx
                                          <div key={r.uuid} className={`comment-reply ${r.author === 'claude' ? 'reply-claude' : 'reply-ben'}`}>
```

to:

```tsx
                                          <div key={r.uuid} className={`comment-reply ${r.author_kind === 'agent' ? 'reply-claude' : 'reply-human'}`}>
```

- [ ] **Step 5: Rename the CSS classes**

In `app/globals.css`, change (lines 817-820):

```css
.reply-ben {
  background: rgba(56, 139, 253, 0.15);
  border-left: 3px solid #58a6ff;
}
```

to:

```css
.reply-human {
  background: rgba(56, 139, 253, 0.15);
  border-left: 3px solid #58a6ff;
}
```

and change (lines 831-833):

```css
.reply-ben .reply-author {
  color: #58a6ff;
}
```

to:

```css
.reply-human .reply-author {
  color: #58a6ff;
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Manual verification**

Run: `npm run build && npm run start`, open a PR, reply to a comment:
- Confirm the reply appears immediately (optimistically) under your default human author's name, not "ben".
- Confirm the reply bubble uses the blue `reply-human` styling, not green.
- Refresh the page; confirm the reply persists with the same name.
- Using the CLI (`claude-reviewer reply <pr> <comment> "msg"`, no `--author` flag), confirm that reply shows green `reply-claude` styling and the name "claude".

- [ ] **Step 8: Commit**

```bash
git add app/prs/\[id\]/page.tsx app/globals.css
git commit -m "fix: use the default human author for PR comment replies, not 'ben'"
```

---

## Task 13: Frontend wiring — browse page conversations

**Files:**
- Modify: `app/browse/page.tsx`

**Interfaces:**
- Consumes: the rewired `POST /api/browse/conversations` and `POST /api/browse/conversations/[id]/messages` (Task 10).

- [ ] **Step 1: Add author_kind to the local ConversationMessage interface**

Update the local `ConversationMessage` interface (lines 27-32):

```ts
interface ConversationMessage {
  uuid: string;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}
```

- [ ] **Step 2: Stop hardcoding 'user' in addComment**

In `addComment` (lines 361-392), change the POST body (lines 368-374) from:

```ts
        body: JSON.stringify({
          repo: repoPath,
          filePath: selectedFile,
          lineNumber: commentingAt,
          content: newComment,
          author: 'user'
        })
```

to:

```ts
        body: JSON.stringify({
          repo: repoPath,
          filePath: selectedFile,
          lineNumber: commentingAt,
          content: newComment
        })
```

- [ ] **Step 3: Stop hardcoding 'user' in addReply**

In `addReply` (around line 394), change the POST body from:

```ts
        body: JSON.stringify({
          content: replyContent,
          author: 'user'
        })
```

to:

```ts
        body: JSON.stringify({
          content: replyContent
        })
```

- [ ] **Step 4: Switch the auto-trigger guard to author_kind**

Change line 186 from:

```ts
              if (messages.length > 0 && messages[messages.length - 1].author === 'claude') {
```

to:

```ts
              if (messages.length > 0 && messages[messages.length - 1].author_kind === 'agent') {
```

- [ ] **Step 5: Switch the CSS class ternary to author_kind**

Change line 653 from:

```tsx
                                          className={`comment-reply ${msg.author === 'claude' ? 'reply-claude' : 'reply-ben'}`}
```

to:

```tsx
                                          className={`comment-reply ${msg.author_kind === 'agent' ? 'reply-claude' : 'reply-human'}`}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Manual verification**

Run: `npm run build && npm run start`, open Browse on a repo, add a comment on a line:
- Confirm it posts under your default human author's name (visible after Claude responds and both messages render), not "user".
- Confirm the auto-trigger-Claude behavior still works (Claude responds once, doesn't loop).
- Confirm Claude's response renders with `reply-claude` (green) styling and your own message with `reply-human` (blue).

- [ ] **Step 8: Commit**

```bash
git add app/browse/page.tsx
git commit -m "fix: use the default human author for browse conversations, not 'user'"
```

---

## Task 14: Frontend wiring — conversations list page

**Files:**
- Modify: `app/browse/conversations/page.tsx`

**Interfaces:**
- Consumes: the rewired `POST /api/browse/conversations/[id]/messages` (Task 10).

- [ ] **Step 1: Add author_kind to the local ConversationMessage interface**

Find and update the local `ConversationMessage` interface (around line 20) the same way as Task 13's Step 1 - add `author_kind: AuthorKind;` after `author: string;`.

- [ ] **Step 2: Stop hardcoding 'user' in addReply**

In `addReply` (lines 257-268), change the POST body from:

```ts
        body: JSON.stringify({
          content: replyContent,
          author: 'user'
        })
```

to:

```ts
        body: JSON.stringify({
          content: replyContent
        })
```

- [ ] **Step 3: Switch the CSS class ternary to author_kind**

Change line 461 from:

```tsx
                                className={`message ${msg.author === 'claude' ? 'message-claude' : 'message-user'}`}
```

to:

```tsx
                                className={`message ${msg.author_kind === 'agent' ? 'message-claude' : 'message-user'}`}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Manual verification**

Run: `npm run build && npm run start`, open `/browse/conversations`, expand a conversation and reply:
- Confirm the reply posts under your default human author's name.
- Confirm the `message-claude`/`message-user` styling still differs correctly between Claude's messages and yours.

- [ ] **Step 6: Commit**

```bash
git add app/browse/conversations/page.tsx
git commit -m "fix: use the default human author in the conversations list page, not 'user'"
```

---

## Task 15: CLI — authors command group and reply resolution

**Files:**
- Create: `claude-reviewer-cli/tests/conftest.py`
- Modify: `claude-reviewer-cli/tests/test_database.py` (remove the now-duplicated local `temp_db` fixture)
- Modify: `claude-reviewer-cli/claude_reviewer/cli.py`
- Test: `claude-reviewer-cli/tests/test_cli.py`

**Interfaces:**
- Consumes: `list_authors`, `get_author_by_name`, `create_author`, `update_author`, `delete_author`, `set_default_author`, `get_default_human_author`, `get_default_agent_author` (Task 4); `_resolve_author_id` inside `add_reply` (Task 6).
- Produces: `claude-reviewer authors list|add|edit|remove|set-default` commands; `reply --author me` now resolves cleanly (already implemented in Task 6's `add_reply` - this task wires the CLI-visible help text and the color-coding fix). A shared `temp_db` pytest fixture in `conftest.py`, usable by every test file in `tests/`.

- [ ] **Step 1: Share the `temp_db` fixture via conftest.py**

`test_cli.py`'s new tests (Step 2 below) need the same temporary-database fixture `test_database.py` already defines locally (`temp_db`, at the top of that file) - but pytest fixtures defined inside one test file aren't visible from another without a shared `conftest.py`. No `conftest.py` exists yet in `claude-reviewer-cli/tests/`.

Create `claude-reviewer-cli/tests/conftest.py`:

```python
"""Shared pytest fixtures for the claude-reviewer-cli test suite."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Iterator

import pytest

from claude_reviewer import database as db


@pytest.fixture
def temp_db() -> Iterator[Path]:
    """Create a temporary database for testing."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        db.init_db(db_path)
        original_path = db.DEFAULT_DB_PATH
        db.DEFAULT_DB_PATH = db_path  # type: ignore[misc]
        yield db_path
        db.DEFAULT_DB_PATH = original_path  # type: ignore[misc]
```

In `claude-reviewer-cli/tests/test_database.py`, delete the now-duplicated local fixture (lines 14-24):

```python
@pytest.fixture
def temp_db() -> Path:
    """Create a temporary database for testing."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        db.init_db(db_path)
        # Temporarily override the default path
        original_path = db.DEFAULT_DB_PATH
        db.DEFAULT_DB_PATH = db_path  # type: ignore[misc]
        yield db_path
        db.DEFAULT_DB_PATH = original_path  # type: ignore[misc]
```

(pytest will pick it up automatically from `conftest.py` instead - no import needed in `test_database.py` itself). Leave the `import tempfile` and `from pathlib import Path` lines at the top of `test_database.py` in place even though they're now only used for the `Path` type hints already present elsewhere in the file (`temp_db: Path` parameters on every test) - only remove them if nothing else in the file references `tempfile`/`Path` after the deletion (check with a quick grep first: `grep -n 'tempfile\.\|Path(' claude-reviewer-cli/tests/test_database.py`).

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/ -v`
Expected: PASS (the full existing suite - this step is a pure refactor, no behavior change yet)

- [ ] **Step 2: Write the failing tests**

Add to `claude-reviewer-cli/tests/test_cli.py` (check the existing imports at the top of the file first and add any missing ones - `from click.testing import CliRunner` and `from claude_reviewer.cli import main` are already present per the existing `TestStopCommand`/`TestPrintComment` classes; add `from claude_reviewer import database as db` and `from pathlib import Path`, neither of which are currently imported in this file). Add a new test class:

```python
class TestAuthorsCommands:
    """Tests for the `authors` command group."""

    def test_list_shows_seeded_authors(self, temp_db: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(main, ["authors", "list"])
        assert result.exit_code == 0
        assert "claude" in result.output

    def test_add_registers_a_new_author(self, temp_db: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(main, ["authors", "add", "Alice", "--kind", "human"])
        assert result.exit_code == 0

        list_result = runner.invoke(main, ["authors", "list"])
        assert "Alice" in list_result.output

    def test_add_rejects_duplicate_name(self, temp_db: Path) -> None:
        runner = CliRunner()
        runner.invoke(main, ["authors", "add", "Bob", "--kind", "human"])
        result = runner.invoke(main, ["authors", "add", "bob", "--kind", "human"])
        assert result.exit_code != 0

    def test_edit_updates_name(self, temp_db: Path) -> None:
        runner = CliRunner()
        runner.invoke(main, ["authors", "add", "Carol", "--kind", "human"])
        result = runner.invoke(main, ["authors", "edit", "Carol", "--name", "Caroline"])
        assert result.exit_code == 0

        list_result = runner.invoke(main, ["authors", "list"])
        assert "Caroline" in list_result.output

    def test_remove_deletes_unreferenced_author(self, temp_db: Path) -> None:
        runner = CliRunner()
        runner.invoke(main, ["authors", "add", "Dave", "--kind", "human"])
        result = runner.invoke(main, ["authors", "remove", "Dave"])
        assert result.exit_code == 0

        list_result = runner.invoke(main, ["authors", "list"])
        assert "Dave" not in list_result.output

    def test_set_default_repoints_default(self, temp_db: Path) -> None:
        runner = CliRunner()
        runner.invoke(main, ["authors", "add", "Erin", "--kind", "human"])
        result = runner.invoke(main, ["authors", "set-default", "Erin"])
        assert result.exit_code == 0

        list_result = runner.invoke(main, ["authors", "list"])
        # Erin's row should now be marked default; Erin appears in output at all
        # confirms the command didn't error - default-marking format is an
        # implementation detail of Step 3 below.
        assert "Erin" in list_result.output


class TestReplyAuthorResolution:
    """Tests for the `reply` command's --author resolution."""

    def test_reply_with_unknown_author_errors_clearly(self, temp_db: Path) -> None:
        runner = CliRunner()
        # `create` needs a real git repo, which this test doesn't need to set
        # up - seed the PR/comment directly via the db module instead.
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")

        result = runner.invoke(main, ["reply", pr_uuid, comment_uuid, "a reply", "--author", "Nobody"])
        assert result.exit_code != 0
        assert "Unknown author" in result.output
```

`temp_db` is now resolved automatically from `conftest.py` (Step 1) - no import needed for the fixture itself, just the `db`/`Path` imports added in Step 2 above.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/test_cli.py::TestAuthorsCommands tests/test_cli.py::TestReplyAuthorResolution -v`
Expected: FAIL with `Error: No such command 'authors'`

- [ ] **Step 4: Write minimal implementation**

In `claude_reviewer/cli.py`, add the `authors` command group after the `reply` command (currently ends around line 990, immediately before `watch`'s `@main.command()` at line 991 - re-grep for `def reply(` / `def watch(` if these have shifted, since a `skills` command group already exists later in the file at line 1627 using the identical `@main.group()`/`@authors.command("...")` pattern used below):

```python
@main.group()
def authors() -> None:
    """Manage registered reviewer/agent identities."""


@authors.command("list")
def authors_list() -> None:
    """List all registered authors."""
    all_authors = db.list_authors()
    default_human = db.get_default_human_author()
    default_agent = db.get_default_agent_author()

    table = Table(title="Authors")
    table.add_column("Kind", style="cyan")
    table.add_column("Name", style="white")
    table.add_column("Email", style="dim")
    table.add_column("Default", style="bold")

    for author in all_authors:
        is_default = (
            author.id == default_human.id if author.kind == "human" else author.id == default_agent.id
        )
        table.add_row(
            author.kind,
            author.name,
            author.email or "-",
            "[green]yes[/green]" if is_default else "",
        )

    console.print(table)


@authors.command("add")
@click.argument("name")
@click.option("--kind", type=click.Choice(["human", "agent"]), required=True, help="Author kind")
@click.option("--email", default=None, help="Optional email")
def authors_add(name: str, kind: str, email: str | None) -> None:
    """Register a new author."""
    try:
        author = db.create_author(kind, name, email)
        console.print(f"[green]Registered {author.kind} author '{author.name}'[/green]")
    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@authors.command("edit")
@click.argument("name")
@click.option("--name", "new_name", default=None, help="New name")
@click.option("--email", default=None, help="New email")
def authors_edit(name: str, new_name: str | None, email: str | None) -> None:
    """Edit an existing author's name/email."""
    author = db.get_author_by_name(name)
    if not author:
        console.print(f"[red]Error: Unknown author '{name}'[/red]")
        sys.exit(1)

    try:
        updated = db.update_author(author.id, name=new_name, email=email)
        console.print(f"[green]Updated author '{updated.name}'[/green]")
    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@authors.command("remove")
@click.argument("name")
def authors_remove(name: str) -> None:
    """Remove an author (refuses if referenced or the current default)."""
    author = db.get_author_by_name(name)
    if not author:
        console.print(f"[red]Error: Unknown author '{name}'[/red]")
        sys.exit(1)

    try:
        db.delete_author(author.id)
        console.print(f"[green]Removed author '{author.name}'[/green]")
    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@authors.command("set-default")
@click.argument("name")
def authors_set_default(name: str) -> None:
    """Make an author the default for its kind."""
    author = db.get_author_by_name(name)
    if not author:
        console.print(f"[red]Error: Unknown author '{name}'[/red]")
        sys.exit(1)

    db.set_default_author(author.id)
    console.print(f"[green]'{author.name}' is now the default {author.kind}[/green]")
```

Update the `reply` command's `--author` help text (currently line 969) from:

```python
@click.option("--author", "-a", default="claude", help="Author name (default: claude)")
```

to:

```python
@click.option(
    "--author",
    "-a",
    default="claude",
    help="Author: 'me' (default human), 'claude' (default agent, default value), or a registered author name",
)
```

Update `reply`'s exception handling (lines 941-947) to also catch the `ValueError` that `add_reply`'s author resolution now raises for an unknown name:

```python
    try:
        reply_uuid = db.add_reply(comment_uuid, message, author)
        console.print(f"[green]Reply added to comment {comment_uuid}[/green]")
        console.print(f"[dim]Reply ID: {reply_uuid}[/dim]")
    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)
```

(No code change needed here beyond the help text - `except ValueError` already catches both the pre-existing "Comment not found"-style errors and the new "Unknown author" error from Task 6, since both are raised as `ValueError`.)

Update `print_comment`'s color check (currently line 61) from:

```python
        author_color = "green" if reply.author == "claude" else "blue"
```

to:

```python
        author_color = "green" if reply.author_kind == "agent" else "blue"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd claude-reviewer-cli && source .venv/bin/activate && pytest tests/ -v`
Expected: PASS (the full suite)

- [ ] **Step 6: Commit**

```bash
git add claude-reviewer-cli/tests/conftest.py claude-reviewer-cli/tests/test_database.py claude-reviewer-cli/claude_reviewer/cli.py claude-reviewer-cli/tests/test_cli.py
git commit -m "feat: add authors CLI command group and lock reply --author to the roster"
```

---

## Task 16: Update bundled skill docs and README CLI reference tables

**Files:**
- Modify: `claude-reviewer-cli/claude_reviewer/skills/claude-reviewer/SKILL.md`
- Modify: `README.md`
- Modify: `claude-reviewer-cli/README.md`

**Interfaces:**
- Consumes: nothing code-facing - this task only updates documentation to reflect Task 15's new `authors` command group and changed `reply --author` semantics, per `CLAUDE.md`'s "Bundled Skills" convention (added since this plan's spec was originally written - the skills directory and README CLI tables are now merged into `main` and this branch, not the unmerged concurrent work referenced in earlier drafts).
- Produces: nothing new consumed by other tasks - this is documentation-only, has no test cycle, and is placed last since it depends on Task 15's exact command names/flags already existing.

- [ ] **Step 1: Update the `claude-reviewer` skill's command reference table**

In `claude-reviewer-cli/claude_reviewer/skills/claude-reviewer/SKILL.md`, the "Command reference" table (currently lines 106-123) has a `reply` row. Change it from:

```markdown
| `reply <id> <comment-uuid> "text"` | Explain what you did about a comment. |
```

to:

```markdown
| `reply <id> <comment-uuid> "text" [-a author]` | Explain what you did about a comment. `-a` defaults to `claude`; use `-a me` to reply as the configured human reviewer instead, or `-a <name>` for any other registered author. |
```

Add a new row directly after it:

```markdown
| `authors list` / `add <name> --kind human\|agent` / `edit <name>` / `remove <name>` / `set-default <name>` | Manage the roster of reviewer/agent identities replies get attributed to. |
```

- [ ] **Step 2: Update the root README's CLI reference table**

In `README.md`, the "CLI Reference" table (lines 142-157) has a `reply` mention implicitly covered by the review workflow section but no explicit `reply`/`authors` row yet (it lists `create`, `list`, `status`, `comments`, `show`, `update`, `merge`, `serve`, `stop`, `open`, `skills install`, `skills list`). Add two new rows after the `claude-reviewer show <id>` row:

```markdown
| `claude-reviewer reply <id> <comment-uuid> "text" [-a author]` | Reply to a comment; `-a` defaults to `claude`, or use `-a me`/`-a <name>` |
| `claude-reviewer authors list\|add\|edit\|remove\|set-default` | Manage reviewer/agent identities used for reply attribution |
```

- [ ] **Step 3: Update the CLI package's README**

In `claude-reviewer-cli/README.md`, the "Commands" table (lines 70-83) is missing `reply`/`authors` entries too. Add after the `show` row:

```markdown
| `reply <id> <comment-uuid> "text" [-a author]` | Reply to a comment (defaults to `claude`; use `-a me` for the configured human reviewer) |
| `authors list\|add\|edit\|remove\|set-default` | Manage reviewer/agent identities |
```

Add a new subsection to the "CLI Reference" section (after the existing "### Merge" section, lines 122-133):

```markdown
### Manage Authors

```bash
# List registered authors (shows which is default for each kind)
claude-reviewer authors list

# Register a new reviewer identity
claude-reviewer authors add "Jane Doe" --kind human --email jane@example.com

# Rename an existing author (past replies referencing it update automatically)
claude-reviewer authors edit "Jane Doe" --name "Jane R. Doe"

# Make an author the default for its kind (used by --author me / --author claude)
claude-reviewer authors set-default "Jane R. Doe"

# Remove an author (refuses if referenced by any reply, or if it's a current default)
claude-reviewer authors remove "Jane R. Doe"
```
```

- [ ] **Step 4: Verify no other command references were missed**

Run: `grep -rn "reply <\|db.add_reply\|--author" README.md claude-reviewer-cli/README.md claude-reviewer-cli/claude_reviewer/skills/*/SKILL.md`
Expected: every match is one of the lines just added/edited above, or (in `claude-reviewer-always/SKILL.md`, if it appears there at all) unrelated prose that doesn't need updating - that skill only references `serve --check`/`list`/`status`, not `reply`/`authors`, so it needs no changes; confirm that by re-reading it rather than assuming.

- [ ] **Step 5: Commit**

```bash
git add README.md claude-reviewer-cli/README.md claude-reviewer-cli/claude_reviewer/skills/claude-reviewer/SKILL.md
git commit -m "docs: document the authors CLI command group and reply --author changes"
```

## Self-Review

**Spec coverage:**
- `authors`/`settings` schema, seeding, no legacy column → Tasks 3, 4.
- Comment-reply write/read path (`author_id`, `author_kind`, retroactive rename) → Tasks 5, 6.
- Repo-conversation write/read path, including the `app/api/claude/route.ts` call sites needing no changes → Tasks 7, 8.
- CRUD (list/add/edit/remove/set-default) at parity, CLI and web → Tasks 9 (API), 11 (web UI), 15 (CLI).
- Block-only delete invariants (referenced, current default) → Tasks 3/4 (`deleteAuthor`/`delete_author`), exercised by Task 11's manual pass.
- `"me"`/`"claude"` pointer-based sentinels, arbitrary names require exact registration → Task 6 (`_resolve_author_id`), Task 15 (CLI help text + error path).
- `kind` replacing all five `=== 'claude'` checks (two CSS ternaries in `page.tsx`/`browse/page.tsx`, the `browse/conversations/page.tsx` ternary, the `browse/page.tsx:186` auto-trigger guard, `print_comment`'s color check in `cli.py`) → Tasks 12, 13, 14, 15.
- `reply-ben` → `reply-human` CSS rename → Task 12.
- Settings page UI (roster table, add form, git-suggestion chip, no separate "Reviewer Identity" form) → Task 11.
- Dropping client-supplied `author` from the three REST routes → Task 10.
- Bundled-skills/README updates (per `CLAUDE.md`'s convention, now that those files are merged into this branch) → Task 16.

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" phrasing found; every step has complete, runnable code or an exact command.

**Type consistency:** `Author`/`CommentReply`/`RepoConversationMessage` field names (`author_id`, `author_kind`, `kind`, `email`) are identical across Tasks 3/4/5/6/7/8/9/11/12/13/14/15 in both TS and Python. `createAuthor`/`create_author`, `updateAuthor`/`update_author`, `deleteAuthor`/`delete_author`, `setDefaultAuthor`/`set_default_author`, `getDefaultHumanAuthor`/`get_default_human_author`, `getDefaultAgentAuthor`/`get_default_agent_author` are named consistently within each language across every task that references them.
