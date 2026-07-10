# Configurable reply author identity (settings page)

## Context

Human-authored replies currently get a hardcoded literal author string instead of the reviewer's real name, in two inconsistent spots:

- `app/prs/[id]/page.tsx:566` and `:590` — `addReply()` (PR comment replies) hardcodes `author: 'ben'`.
- `app/browse/page.tsx:373` and `:403` — `addComment()`/`addReply()` (repo-level conversations, independent of PRs) hardcode `author: 'user'` instead.

Both literals end up in the `author` column (`comment_replies.author`, `repo_conversation_messages.author` — both `TEXT NOT NULL DEFAULT 'user'`, schemas at `lib/database.ts:219-226`/`:254-264`, mirrored in `claude-reviewer-cli/claude_reviewer/database.py:127-137`) and are rendered verbatim as the visible label (`{r.author}:` at `page.tsx:1316`, `browse/page.tsx:655`, `browse/conversations/page.tsx:451,463`).

The literal string `'claude'` is also load-bearing beyond styling — it's a real behavioral check in five places:

- `app/prs/[id]/page.tsx:1315` and `app/browse/page.tsx:653` — CSS class choice (`reply-claude` vs `reply-ben`, colors at `app/globals.css:812-833`).
- `app/browse/conversations/page.tsx:461` — CSS class choice (`message-claude` vs `message-user`).
- `app/browse/page.tsx:186` — **actual logic**: decides whether to auto-trigger another Claude response (skips if the last message was already Claude's).
- `claude-reviewer-cli/claude_reviewer/cli.py:59` — terminal color-coding when printing replies.

On the CLI side, `claude_reviewer/cli.py:928` (`reply` command) defaults `--author` to `"claude"` — Claude's own identity when it runs the documented `CLAUDE.md` workflow (`claude-reviewer reply <pr-id> <comment-uuid> "..."`, no `--author` flag). The same literal is used for the AI's own automated review-response flow at `cli.py:1533` (`db.add_reply(comment.uuid, response, author="claude")`) and, on the web side, for Claude's automated conversation replies at `app/api/claude/route.ts:53,85` (`addRepoConversationMessage(conversationUuid, result.response, 'claude')`).

No settings/config system exists anywhere in the app today (`lib/preferences.ts` is unrelated — it infers coding-style preferences into `CLAUDE.md`). The web app (`lib/database.ts`) and the Python CLI (`claude_reviewer/database.py`) share one SQLite DB at `~/.claude-reviewer/data.db`, each carrying its own copy of the schema-init SQL plus a couple of precedent-setting additive `ALTER TABLE` migrations (`migrateCommentsEndLine`/`migrateCommentsCommitSha` in `lib/database.ts:271-304`, `_migrate_comments_end_line`/`_migrate_comments_commit_sha` in `database.py:218-...`, both guarded by a `PRAGMA table_info` column check and a "duplicate column" catch for races between the two processes). Neither side currently reads git config.

## How this design evolved

Three rounds of brainstorming, each changing the shape of the solution:

1. **First pass**: a plain `settings` key-value table storing a name/email string pair, copied onto each reply.
2. **Second pass**: replaced with an `authors` table — replies reference an `author_id` instead of copying a string, so renaming is retroactive and a `kind` field (`human`/`agent`) replaces the `=== 'claude'` string checks. Exactly one human row + one agent row, no roster management.
3. **Final pass (this document)**: full CRUD for the author roster, on both the CLI and the web settings page — so a `settings` table comes back after all, but narrowly: just two pointers (`default_human_author_id`, `default_agent_author_id`) into `authors`, needed now that more than one row per kind can exist.

## Decisions

- **`authors` table, referenced by FK, not copied by value.** Every reply/message stores an `author_id`. Renaming an author is retroactive — every past reply referencing that row picks up the new name via `JOIN`, not a copy.
- **`settings` table holds exactly two pointers**, not a general key-value store: `default_human_author_id`, `default_agent_author_id`. These are what `"me"` and `"claude"` resolve to (see below), and what the web reply flow and the automated Claude-response flow use instead of hardcoding a name.
- **Full roster CRUD, CLI and web at parity**: list/add/edit/remove/set-default, both surfaces backed by the same underlying functions.
- **`"me"` and `"claude"` are both pointer-based sentinels**, not name lookups — `"me"` → `default_human_author_id`, `"claude"` → `default_agent_author_id`. This is what makes the existing hardcoded automated call sites (`app/api/claude/route.ts:53,85`, `cli.py:1533`) robust even if the default agent is ever renamed away from literally being called "claude." Any other value passed to `--author` is an exact case-insensitive lookup against `authors.name`, erroring clearly if unregistered — **no more silent freeform/raw-text fallback** for new replies (a change from the second-pass design, made possible by locking `--author` down to the roster).
- **`kind` replaces every `=== 'claude'` check that currently drives behavior**, including the non-cosmetic one (`browse/page.tsx:186`'s auto-trigger guard), and generalizes it: any row with `kind='agent'` (not just one literally named "claude") gets agent treatment — future-proofing for more than one registered agent identity.
- **Deletion is block-only, no override.** Refuses if the author is referenced by any existing reply/message, or if it's a current default — full stop, no cascade-delete and no "detach" escape hatch. The only way to remove a referenced or default author is to first make sure nothing points at it (there's no bulk-reassign tool in this pass; removing a default requires `set-default` to another row first).
- **`kind` is immutable after creation.** Only `name`/`email` are editable. Fixing a mis-registered kind means delete (if unblocked) + recreate.
- **No backward-compatible legacy column.** This is pre-1.0 local dev tooling — the user explicitly confirmed existing `comment_replies`/`repo_conversation_messages` data can be discarded rather than preserved through a careful additive migration. `author_id` is `NOT NULL` from the start (no nullable FK, no legacy `author` TEXT fallback column, no heuristic `author_kind` fallback in the read path). This meaningfully simplifies the schema, the migration, and every query that reads a reply/message.
- **The settings page's old standalone "Reviewer Identity" form is gone**, folded into a single "Authors" roster table — editing the row that happens to be the default human *is* "editing your identity," so a separate form would just be a redundant view over the same data.
- **No `configured` flag.** Rather than tracking "has this ever been explicitly saved" to decide when to show a git-config hint, the settings page always shows a live "git config says X — use this?" suggestion next to the default human row whenever the current live git value differs from what's stored, computed fresh on every page load. Simpler than a boolean, and doesn't need a migration if git config changes later.

## Data model

```sql
CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_authors_kind ON authors(kind);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Added identically to both schema-init blocks (`lib/database.ts`'s `initSchema()`, `claude_reviewer/database.py`'s `SCHEMA_SQL`), after the `comment_replies` block.

**Seeding** (new function, e.g. `seedAuthors(db)` / `_seed_authors(conn)`, called once from `initSchema()`/`init_db()`, guarded by `WHERE NOT EXISTS` so it only runs — and only shells out to git — on a database's first-ever initialization):

```sql
INSERT INTO authors (kind, name)
SELECT 'agent', 'claude' WHERE NOT EXISTS (SELECT 1 FROM authors WHERE kind = 'agent');
```
and, for the human row, a conditional (JS/Python, not pure SQL) that shells out to `git config --global --get user.name`/`user.email` if no human row exists yet, inserting `(kind='human', name=<git name or 'reviewer'>, email=<git email or NULL>)`. Immediately after, if `settings` has no `default_human_author_id`/`default_agent_author_id` yet, set them to the two newly-seeded rows' ids (guarded the same way, so re-running never clobbers a `set-default` choice made later).

**Rebuilding `comment_replies` and `repo_conversation_messages`**: both tables' schema definitions change from `author TEXT NOT NULL DEFAULT 'user'` to `author_id INTEGER NOT NULL REFERENCES authors(id)` — no legacy text column at all. Existing data in these two tables predates the `authors` table and has no `author_id` to backfill from, and the user has confirmed it's fine to discard it rather than build a careful backfill (this is pre-1.0 local dev tooling, not a production migration). The migration (new function, e.g. `rebuildReplyTables(db)` / `_rebuild_reply_tables(conn)`, called once at the top of `initSchema()`/`init_db()`, **before** the main `CREATE TABLE IF NOT EXISTS` block runs) detects a pre-this-feature database by checking whether `authors` exists yet:

```sql
-- Only runs once: if `authors` doesn't exist yet, this DB predates the
-- author_id column, so drop the two tables and let the normal
-- `CREATE TABLE IF NOT EXISTS` block below recreate them in the new shape.
DROP TABLE IF EXISTS comment_replies;
DROP TABLE IF EXISTS repo_conversation_messages;
```
Both tables' `CREATE TABLE IF NOT EXISTS` statements in the main schema block are updated to the new `author_id INTEGER NOT NULL REFERENCES authors(id)` column in place of `author TEXT NOT NULL DEFAULT 'user'`. Since `authors` is seeded immediately after this same schema-init pass, `author_id` can be `NOT NULL` from the very first insert.

## Read path

Every place that assembles a reply/message row — `getCommentsWithReplies` and `getRepoConversationWithMessages`/`listRepoConversations`'s `latest_message` subquery in `lib/database.ts`, and the Python equivalents feeding `get_unanswered_pr_comments`, the CLI's `comments` command, and `get_unanswered_conversations` in `database.py` — `JOIN authors ON authors.id = <table>.author_id` (a plain inner join — `author_id` is `NOT NULL`, so every row always matches) and expose:

```ts
export interface CommentReply {
  id: number;
  uuid: string;
  comment_id: number;
  author_id: number;
  author: string;                  // authors.name via JOIN — live, reflects renames
  author_kind: 'human' | 'agent';  // authors.kind via JOIN
  content: string;
  created_at: string;
}
```
(mirrored for `RepoConversationMessage`, and for the Python dataclasses in `models.py:74-80,110-118`, plus a new `Author` dataclass: `id`, `kind`, `name`, `email`.) No fallback/heuristic branch is needed anywhere in the read path — every row has a real, resolvable `author_id`.

## Write path

- **`lib/database.ts`'s `addReply`** (`comment_replies`, PR comments) is only ever called from the human-facing web route (`app/api/prs/[id]/comments/route.ts:49` — verified no other TS caller passes a custom author). It drops its `author` parameter entirely and always resolves `settings.default_human_author_id`.
- **`lib/database.ts`'s `createRepoConversation`/`addRepoConversationMessage`** are called from *both* the human-facing REST routes (`app/api/browse/conversations/route.ts:42`, `app/api/browse/conversations/[id]/messages/route.ts:33`) *and* directly from the server-side Claude-response flow (`app/api/claude/route.ts:53,85`, passing the literal `'claude'`). They keep an author-hint parameter (`'human' | 'claude'`), resolved via the same two settings pointers. Because the Claude-response call sites already pass the exact string `'claude'`, **those two call sites need no changes** — only the two REST route handlers change, to stop reading `author` out of the request body (closing the "client can spoof authorship" gap).
- **Python's `add_reply`** (`database.py:641`) keeps its `author: str = "claude"` parameter (CLI-facing) but resolves internally: `"me"` → `default_human_author_id`, `"claude"` → `default_agent_author_id`, anything else → exact case-insensitive lookup against `authors.name`, raising `ValueError` if no match (surfaced by the CLI as a red error + exit, matching the existing PR-not-found/comment-not-found pattern in the `reply` command).

## CRUD operations (mirrored in `lib/database.ts` and `database.py`)

- `listAuthors()` — all rows, each annotated with whether it's the current default for its kind.
- `getAuthorByName(name)` — case-insensitive.
- `getDefaultHumanAuthor()` / `getDefaultAgentAuthor()` — resolve the settings pointer, join to `authors`.
- `createAuthor(kind, name, email?)` — surfaces a friendly error on a `UNIQUE` violation (duplicate name, case-insensitive).
- `updateAuthor(id, { name?, email? })` — `kind` isn't part of the update shape at all.
- `deleteAuthor(id)` — throws with a clear reason in either blocking case:
  - referenced by any `comment_replies`/`repo_conversation_messages` row (message includes the count), or
  - is the current value of `default_human_author_id`/`default_agent_author_id` for its kind ("repoint the default first").
- `setDefaultAuthor(id)` — looks up the target's `kind`, updates the matching settings key. Validates the row exists.

## API surface (web)

- `GET /api/authors` — all rows plus `isDefaultHuman`/`isDefaultAgent` booleans, plus a `gitSuggestion: { name, email } | null` (live `git config --global` shell-out) for the frontend to offer next to the default human row.
- `POST /api/authors` — `{ name, kind, email? }`.
- `PATCH /api/authors/[id]` — `{ name?, email? }`.
- `DELETE /api/authors/[id]` — `409` with the specific reason if blocked.
- `POST /api/authors/[id]/default` — makes this row the default for its kind.

All in a new `app/api/authors/route.ts` + `app/api/authors/[id]/route.ts` + `app/api/authors/[id]/default/route.ts`, following the try/catch + `NextResponse.json` conventions in `app/api/prs/[id]/comments/route.ts`. The previously-planned standalone `/api/settings` route is dropped — "default" is just a property on each row in the list response.

## Settings page (web)

- New `app/settings/page.tsx` — a client component, fetch-on-mount + local-state, matching the existing pages' pattern.
- New nav entry in `components/HeaderNav.tsx` (after "Conversations"): a `Settings` (gear) `lucide-react` icon, `href="/settings"`, added to `isActive` the same way `/browse` is handled.
- One "Authors" section: a table (kind, name, email, default badge) with inline edit, delete, and "make default" per row, plus an add-author form (name, kind, optional email). The default human row's name/email fields show a "git config says X — use this?" chip whenever the live git value differs from the stored one; clicking it fills the edit form (doesn't save automatically).

## Reply-flow wiring

- `app/prs/[id]/page.tsx`'s `addReply()` (560-628): stops sending `author` in the POST body; the optimistic `tempReply.author` (566) uses the default human's name (fetched once via `GET /api/authors` on mount, falling back to the literal `"reviewer"` if the fetch fails). Line 1315's ternary switches from `r.author === 'claude'` to `r.author_kind === 'agent'`, and the false-branch class renames `reply-ben` → `reply-human`.
- `app/browse/page.tsx`: `addComment()`/`addReply()` (361-...) drop the `author: 'user'` literal from their POST bodies the same way. Line 186's auto-trigger guard switches to `messages[last].author_kind === 'agent'`. Line 653's ternary switches the same way as `page.tsx:1315`.
- `app/browse/conversations/page.tsx:461`: ternary switches to `msg.author_kind === 'agent'` (class names `message-claude`/`message-user` unchanged).

## CLI wiring

- `cli.py`'s `reply` command (`:928-947`): `--author` default stays the literal `"claude"` (unchanged — resolves to `default_agent_author_id` via the sentinel logic above, still zero-flag-compatible with the documented `CLAUDE.md` workflow). New sentinel `--author me` resolves to `default_human_author_id`. Any other value must exactly match a registered `authors.name` (case-insensitive) or the command errors out.
- No change to the automated call at `cli.py:1533` (still explicit `author="claude"`, now resolving through the settings pointer instead of a name match).
- `cli.py:59` (colored reply printing): `"green" if reply.author_kind == "agent" else "blue"`, replacing `reply.author == "claude"`.
- New `authors` command group: `claude-reviewer authors list`, `authors add <name> --kind {human,agent} [--email EMAIL]`, `authors edit <name> [--name NEW] [--email EMAIL]`, `authors remove <name>`, `authors set-default <name>`.

## Edge cases

- **No git config at seed time**: falls back to `name='reviewer'`, `email=NULL`; the settings page's "use this" chip simply never appears (the live git shell-out keeps returning nothing to suggest).
- **Docker deployment** (`HOST_PATH_PREFIX`, `lib/git.ts:21-27`): the git-config read reflects the container's own global config, not necessarily the host user's, unless bind-mounted. Same class of limitation as other host/container path handling already in the codebase; not addressed here.
- **Deleting a referenced author**: blocked with the reference count; no bulk-reassign tool exists in this pass.
- **Deleting a current default**: blocked; `set-default` to a different row of the same kind first.
- **Duplicate name on add/rename**: blocked by the `UNIQUE COLLATE NOCASE` constraint, surfaced as a friendly error (not a raw SQLite exception).
- **Upgrading a database with pre-existing replies**: `comment_replies`/`repo_conversation_messages` are dropped and recreated in the new `author_id NOT NULL` shape — existing reply/message content is discarded, not migrated. Explicitly accepted (pre-1.0 local tooling); the rest of the database (PRs, comments, reviews) is untouched.
- **Concurrent web + CLI writes to `authors`/`settings`**: same WAL + `busy_timeout` concurrency handling already relied on for every other shared table.

## Testing / verification

- Vitest: CRUD functions (`createAuthor`/`updateAuthor`/`deleteAuthor`/`setDefaultAuthor`/`listAuthors`), including both delete-blocking cases and the duplicate-name error; the seeding function (with and without git config reachable); `rebuildReplyTables` against a fixture DB pre-populated with legacy `'ben'`/`'user'`/`'claude'` rows in the old schema — confirm both tables end up empty but present in the new `author_id NOT NULL` shape, and that unrelated tables (`pull_requests`, `comments`) are untouched. Following `__tests__/database.test.ts`'s direct-function-call pattern and `__tests__/git.test.ts`'s temp-repo-with-`git config` convention.
- Python: mirrored tests in `test_database.py` (seeding, table rebuild, CRUD, delete-blocking, sentinel resolution) and `test_cli.py` (`authors` subcommands, `--author me`/`--author claude`/`--author <registered name>`/`--author <unregistered name>` error), plus a `get_global_git_user()`-equivalent test in `test_git_ops.py`.
- `npx tsc --noEmit`.
- Manual pass: on a database with existing PR comment replies/repo-conversation messages from before this change, confirm the app starts cleanly after upgrade and those old replies/messages are gone (not erroring, not half-migrated) while PRs/comments remain intact. Visit `/settings`, confirm the Authors table lists both seeded rows with correct default badges; with `git config user.name` set differently from the stored default-human name, confirm the "use this" chip appears; add a second human author via the CLI, confirm it shows up in the web table; try deleting a default or referenced author from both surfaces, confirm both refuse with the same reason; `set-default` to the new author, confirm the badge moves and new replies now use it. Post a new PR comment reply and a repo-conversation reply/comment — confirm the default human's name appears. From a terminal, `claude-reviewer reply <pr> <comment> "msg" --author me` and `--author claude` — confirm correct resolution; run the documented Claude workflow's `claude-reviewer reply` with no `--author` — confirm it's still attributed to the default agent and still triggers `reply-claude`/green coloring. In the browse view, confirm Claude's auto-response guard (`browse/page.tsx:186`) still skips re-triggering after Claude's own message.
