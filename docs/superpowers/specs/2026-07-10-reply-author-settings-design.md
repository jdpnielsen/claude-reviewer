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

No settings/config system exists anywhere in the app today (`lib/preferences.ts` is unrelated — it infers coding-style preferences into `CLAUDE.md`). The web app (`lib/database.ts`) and the Python CLI (`claude_reviewer/database.py`) share one SQLite DB at `~/.claude-reviewer/data.db`, each carrying its own copy of the schema-init SQL (`CREATE TABLE IF NOT EXISTS ...`, plus a couple of precedent-setting additive `ALTER TABLE` migrations — `migrateCommentsEndLine`/`migrateCommentsCommitSha` in `lib/database.ts:271-304`, `_migrate_comments_end_line`/`_migrate_comments_commit_sha` in `database.py:218-...` — both guarded by a `PRAGMA table_info` column check and a "duplicate column" catch for races between the two processes). Neither side currently reads git config.

## Decisions made during brainstorming

This spec went through two rounds. The first round settled on a plain `settings` key-value table storing a name/email string pair. On review, the user pointed out that gluing a raw string onto each reply loses the ability to (a) rename yourself without abandoning your reply history, and (b) robustly tell "Claude's own reply" apart from "human follow-up" — since today that's just a literal string equality check with no structure behind it. This revision replaces the plain string with a durable identity:

- **`authors` table, not a key-value `settings` table.** Every reply/message references an `author_id` FK into a small `authors` table, instead of copying a name string. The originally-planned generic `settings` KV table is dropped from this pass entirely (confirmed with the user) — there's no remaining consumer for it once identity lives in `authors`, and it can be introduced later if an unrelated setting actually shows up.
- **Renaming is retroactive.** `authors.name`/`email` are mutable; every past reply that references that row picks up the new name automatically (a `JOIN`, not a copy). This is the intended behavior — "update names without losing context."
- **Exactly one human row + one agent row**, seeded once. This is a single-user local tool (mirroring the existing single-user assumption already baked into the top-level `comments` table having no author field at all) — no UI for picking "which human am I," no multi-reviewer support. The table shape doesn't prevent adding more rows later; the *lookup* logic (`WHERE kind = 'human' LIMIT 1`) just doesn't need to handle more than one today.
- **`kind` replaces the `=== 'claude'` string check everywhere it currently drives behavior**, including the one non-cosmetic case (`browse/page.tsx:186`'s auto-trigger guard), not just the styling call sites.
- **CLI stays backward-compatible for ad-hoc names.** `--author` keeps accepting arbitrary free text (existing behavior, no enum constraint) for guest/one-off use; only the two well-known sentinels (`"claude"`, and new `"me"`) resolve through the `authors` table. An arbitrary string still writes straight into the legacy `author` text column with no `author_id`, exactly as it does today.
- **CSS rename retained from round one**: `reply-ben` → `reply-human` (`app/globals.css:817-833`, `page.tsx:1315`, `browse/page.tsx:653`) — "ben" is inaccurate now that the name is configurable. `message-claude`/`message-user` (`browse/conversations/page.tsx:461`) keep their existing names; only the condition driving them switches to `kind`.
- **No retroactive rewrite of the legacy `author` TEXT column** on already-existing rows beyond the one-time backfill described below — it stays as an immutable historical fallback for rows that never get an `author_id` (freeform CLI names).

## Data model

New table, added identically to both schema-init blocks (`lib/database.ts`'s `initSchema()`, after the `comment_replies` block at `:219-228`; `claude_reviewer/database.py`'s `SCHEMA_SQL`, after the equivalent block at `:127-137`):

```sql
CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    name TEXT NOT NULL,
    email TEXT,
    configured BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_authors_kind ON authors(kind);
```

`configured` is only meaningful for the human row: `FALSE` means "this is still whatever we auto-seeded (git config or the literal fallback `'reviewer'`), never explicitly confirmed by the user" — used purely to decide whether the settings page shows a "from git config" hint. It's set `TRUE` the moment a human saves via the settings page.

**Seeding** (new function, e.g. `seedAuthors(db)` / `_seed_authors(conn)`, called once from `initSchema()`/`init_db()`, guarded by `WHERE NOT EXISTS` so it only actually runs — and only actually shells out to git — on a database's very first ever initialization):

```sql
INSERT INTO authors (kind, name)
SELECT 'agent', 'claude'
WHERE NOT EXISTS (SELECT 1 FROM authors WHERE kind = 'agent');
```
and, for the human row, a conditional (JS/Python, not pure SQL) that shells out to `git config --global --get user.name`/`user.email` if no human row exists yet, inserting `(kind='human', name=<git name or 'reviewer'>, email=<git email or NULL>, configured=FALSE)`.

**Migration of existing tables** (new function, e.g. `migrateReplyAuthorId(db)` / `_migrate_reply_author_id(conn)`, following the exact guarded-`ALTER`-plus-"duplicate column"-catch shape as `migrateCommentsEndLine`): both `comment_replies` and `repo_conversation_messages` get a nullable `author_id INTEGER REFERENCES authors(id)` column added. One-time backfill, run after the column exists and after `authors` is seeded:

```sql
UPDATE comment_replies SET author_id = (SELECT id FROM authors WHERE kind = 'agent')
WHERE author_id IS NULL AND author = 'claude';
UPDATE comment_replies SET author_id = (SELECT id FROM authors WHERE kind = 'human')
WHERE author_id IS NULL;
-- (same two statements for repo_conversation_messages)
```
The existing `author` TEXT NOT NULL column on both tables is **not dropped** — new inserts through the two well-known identities still populate it (mirroring the resolved name, redundant but harmless, and keeps the `NOT NULL` constraint trivially satisfied without a table rebuild); freeform CLI names continue to rely on it exclusively (`author_id` stays `NULL` for those rows).

## Read path

Every place that assembles a reply/message row — `getCommentsWithReplies` and `getRepoConversationWithMessages`/`listRepoConversations`'s `latest_message` subquery in `lib/database.ts`, and the Python equivalents feeding `get_unanswered_pr_comments`, the CLI's `comments` command, and `get_unanswered_conversations` in `database.py` — `LEFT JOIN authors ON authors.id = <table>.author_id` and expose two fields where there was one:

```ts
export interface CommentReply {
  id: number;
  uuid: string;
  comment_id: number;
  author: string;             // COALESCE(authors.name, legacy author text) — live, reflects renames
  author_kind: 'human' | 'agent';  // authors.kind, or a heuristic on the legacy text for freeform rows
  content: string;
  created_at: string;
}
```
(mirrored for `RepoConversationMessage`, and for the Python `CommentReply`/`RepoConversationMessage` dataclasses in `models.py:74-80,110-118`, plus a new `Author` dataclass: `id`, `kind`, `name`, `email`, `configured`.)

For rows with `author_id IS NULL` (freeform CLI names), `author_kind` falls back to the same heuristic used today: `'agent' if author == 'claude' else 'human'` — identical behavior to the current string check, just relocated.

## Write path

- **`lib/database.ts`'s `addReply`** (`comment_replies`, PR comments) is only ever called from the human-facing web route (`app/api/prs/[id]/comments/route.ts:49` — verified no other TS caller passes a custom author). It drops its `author` parameter entirely and always resolves the one `kind='human'` row.
- **`lib/database.ts`'s `createRepoConversation`/`addRepoConversationMessage`** (`repo_conversations`/`repo_conversation_messages`) are called from *both* the human-facing REST routes (`app/api/browse/conversations/route.ts:42`, `app/api/browse/conversations/[id]/messages/route.ts:33`) *and* directly from the server-side Claude-response flow (`app/api/claude/route.ts:53,85`, passing the literal `'claude'`). They keep an author-hint parameter, but it now selects between the two `authors` rows instead of being copied verbatim: `hint === 'claude'` → agent row, anything else (including the current default `'user'`) → human row. Because the Claude-response call sites already pass the exact string `'claude'`, **those two call sites need no changes** — only the two REST route handlers change, to stop reading `author` out of the request body and drop it (closing the "client can spoof authorship" gap, matching the PR-comments route).
- **Python's `add_reply`** (`database.py:641`) keeps its `author: str = "claude"` parameter (CLI-facing) but resolves internally: `"me"` → human row, `"claude"` → agent row, anything else → freeform legacy text with `author_id = NULL` (unchanged behavior).

## API surface (web)

- **`GET /api/settings`** — reads the human row (`name`, `email`, `configured`) plus a fresh `git config --global --get user.name`/`user.email` shell-out (surfaced only while `configured === false`, as a suggestion the still-editable form can show a hint for).
- **`PUT /api/settings`** — body `{ name: string, email: string }`, 400 if `name` trims empty, `UPDATE authors SET name=?, email=?, configured=TRUE, updated_at=CURRENT_TIMESTAMP WHERE kind='human'`.

Both in a new `app/api/settings/route.ts`, following the try/catch + `NextResponse.json` conventions in `app/api/prs/[id]/comments/route.ts`.

## Settings page (web)

- New `app/settings/page.tsx` — a client component, fetch-on-mount + local-state form, matching the existing pages' pattern.
- New nav entry in `components/HeaderNav.tsx` (after "Conversations"): a `Settings` (gear) `lucide-react` icon, `href="/settings"`, added to `isActive` the same way `/browse` is handled.
- One "Reviewer Identity" section: Name/Email fields prefilled from `GET /api/settings`'s resolved values (the saved name/email if `configured`, otherwise the live git suggestion), with a small "(from git config)" hint shown only while `configured === false`. Save calls `PUT /api/settings`; on success, re-fetch to confirm `configured` flipped (hint disappears).

## Reply-flow wiring

- `app/prs/[id]/page.tsx`'s `addReply()` (560-628): stops sending `author` in the POST body at all (server resolves it); the optimistic `tempReply.author` (566) uses the human name fetched once from `GET /api/settings` on mount (falling back to the literal `"reviewer"` if that fetch fails, so replying never breaks). Line 1315's ternary switches from `r.author === 'claude'` to `r.author_kind === 'agent'`, and the false branch's class renames `reply-ben` → `reply-human`.
- `app/browse/page.tsx`: `addComment()`/`addReply()` (361-...) drop the `author: 'user'` literal from their POST bodies the same way. Line 186's auto-trigger guard switches to `messages[last].author_kind === 'agent'`. Line 653's ternary switches the same way as `page.tsx:1315`.
- `app/browse/conversations/page.tsx:461`: ternary switches to `msg.author_kind === 'agent'` (class names `message-claude`/`message-user` unchanged).

## CLI wiring

- `cli.py`'s `reply` command (`:928-947`): `--author` default stays `"claude"` (Claude's own identity, untouched). New sentinel: `--author me` resolves to the human row's current name via `get_human_author()`.
- No change to the automated call at `cli.py:1533` (still explicit `author="claude"`).
- `cli.py:59` (colored reply printing): `"green" if reply.author_kind == "agent" else "blue"`, replacing the `reply.author == "claude"` check.

## Edge cases

- **No git config at all**: seeding falls back to `name='reviewer'`, `email=NULL`, `configured=FALSE`; settings page shows empty fields with no git hint.
- **Docker deployment** (`HOST_PATH_PREFIX`, `lib/git.ts:21-27`): the seed-time `git config --global` read reflects the container's own global config, not necessarily the host user's, unless bind-mounted. Same class of limitation as other host/container path handling already in the codebase; not addressed here.
- **Migration on a database with pre-existing replies**: every existing `comment_replies`/`repo_conversation_messages` row backfills to either the seeded agent row (if its legacy `author = 'claude'`) or the seeded human row (everything else, including old `'ben'`/`'user'` values) — no data loss, no row left with `author_id IS NULL` after migration except future freeform CLI names.
- **Freeform CLI `--author "Someone Else"`**: unchanged from today — raw text in the legacy `author` column, `author_id NULL`, `author_kind` falls back to the `'agent' if text == 'claude' else 'human'` heuristic.
- **Concurrent web + CLI writes to `authors`**: same WAL + `busy_timeout` concurrency handling already relied on for every other shared table.

## Testing / verification

- Vitest: `getHumanAuthor`/`getAgentAuthor`/`updateHumanAuthor`, the seeding function (with and without git config reachable), and the `author_id` backfill migration run against a fixture DB pre-populated with legacy `'ben'`/`'user'`/`'claude'` rows — confirm correct id assignment and that the legacy `author` column is untouched. Following `__tests__/database.test.ts`'s direct-function-call pattern and `__tests__/git.test.ts`'s temp-repo-with-`git config` convention.
- Python: mirrored tests in `test_database.py` (seeding, migration/backfill, `get_human_author`/`get_agent_author`) and `test_cli.py` (`--author me` sentinel, `--author "custom"` freeform passthrough unchanged, `--author claude` default unchanged), plus a `get_global_git_user()` test in `test_git_ops.py`.
- `npx tsc --noEmit`.
- Manual pass: on a database with existing PR comment replies/repo-conversation messages from before this change, confirm they still render (now via the join) with the correct name and the correct `reply-human`/`reply-claude` styling after migration. Visit `/settings` with `git config user.name` set — confirm prefill + hint; save an override — confirm hint disappears and survives reload, and that previously-posted replies from the *same* human immediately show the new name (retroactive rename). Post a new PR comment reply and a repo-conversation reply/comment — confirm the configured name appears. From a terminal, `claude-reviewer reply <pr> <comment> "msg" --author me` — confirm it posts under the configured name; run the documented Claude workflow's `claude-reviewer reply` with no `--author` — confirm it's still `"claude"` and still triggers `reply-claude`/green coloring. In the browse view, confirm Claude's auto-response guard (`browse/page.tsx:186`) still skips re-triggering after Claude's own message.
