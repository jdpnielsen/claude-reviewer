# Configurable reply author name (settings page)

## Context

Human-authored replies currently get a hardcoded literal author string instead of the reviewer's real name, in two inconsistent spots:

- `app/prs/[id]/page.tsx:566` and `:590` — `addReply()` (PR comment replies) hardcodes `author: 'ben'`, both in the optimistic `tempReply` and the POST body to `app/api/prs/[id]/comments/route.ts`.
- `app/browse/page.tsx:373` and `:403` — `addComment()`/`addReply()` (repo-level conversations, independent of PRs) hardcode `author: 'user'` instead.

Both literals end up in the `author` column (`comment_replies.author`, `repo_conversation_messages.author` — both `TEXT NOT NULL DEFAULT 'user'`, schemas at `lib/database.ts:219-226` / `:254-...` and mirrored in `claude-reviewer-cli/claude_reviewer/database.py:128-137`) and are rendered verbatim as the visible label (`<span className="reply-author">{r.author}:</span>` at `page.tsx:1316` and `browse/page.tsx:655`).

Separately, `r.author === 'claude'` is used as a display-only convention (`page.tsx:1315`, `browse/page.tsx:653`) to pick a CSS class — `reply-claude` (green) vs `reply-ben` (blue, `app/globals.css:812-833`) — for AI vs. human reply bubbles. This convention is orthogonal to whatever literal name is stored; it only checks for the exact string `'claude'`.

On the CLI side, `claude_reviewer/cli.py:928` (`reply` command) already defaults `--author` to `"claude"` — this is Claude's own identity when it runs the documented `CLAUDE.md` workflow (`claude-reviewer reply <pr-id> <comment-uuid> "..."` with no `--author` flag). `add_reply` is called the same way at `cli.py:1533` for Claude's automated review-response flow.

No settings/config system exists anywhere in the app today (no settings table, no config file, no `/settings` route — `lib/preferences.ts` is unrelated, it infers coding-style preferences into `CLAUDE.md`). This is a new concept, built to be extensible since more settings are expected later.

The web app (`lib/database.ts`) and the Python CLI (`claude_reviewer/database.py`) already share one SQLite DB at `~/.claude-reviewer/data.db` and each carry their own copy of the schema-init SQL (`CREATE TABLE IF NOT EXISTS ...`, additive/idempotent). Neither side currently reads git config; `lib/git.ts` and `claude_reviewer/git_ops.py` both shell out to git for repo-specific operations (commit log, diff, branch ops) but have no `user.name`/`user.email` reader.

## Decisions made during brainstorming

- **Scope**: covers both the web UI (settings page + wherever a human posts a reply/comment) and the CLI (a way for a human running the CLI directly to use their configured name), not just the originally-named `'ben'` call site. The `app/browse/page.tsx` call sites using the literal `'user'` are functionally the same gap and are fixed as part of this work.
- **Persistence**: a new generic key-value `settings` table in the shared SQLite DB (not a JSON config file, not one dedicated column per setting) — both the TS and Python side already read/write this DB, and a key-value shape means future settings need no schema migration.
- **Fields**: reviewer name and email, both configurable on the settings page. Email isn't consumed anywhere today (no avatar/gravatar feature exists) — it's captured now because it's part of the same "who is reviewing" identity and free to prefill from git alongside the name.
- **Effective-value resolution** (the one rule used everywhere: settings page prefill, reply flows, and the CLI `me` sentinel): **saved value (row exists in `settings`) → else live `git config --global user.name`/`user.email` → else literal fallback `"reviewer"` for name** (email has no forced fallback; it stays unset). A row is considered "saved" the moment it exists, even if its value is an empty string — so explicitly clearing the email field and saving means "no email", not "fall back to git every time."
- **CLI default untouched**: `--author` keeps defaulting to `"claude"` — that's Claude's own AI identity, not a placeholder for "whoever's on this machine." A human manually running the CLI opts in with a new sentinel: `--author me`, which resolves via the same effective-value logic.
- **CSS class rename**: `reply-ben` → `reply-human` (both the class definitions in `app/globals.css:817-833` and the two ternaries at `page.tsx:1315` / `browse/page.tsx:653`) since "ben" is no longer an accurate name for "the non-Claude reply style" now that the human's name is configurable. Purely a rename — same colors, same `author === 'claude'` check, no behavior change.
- **No retroactive rewrite**: existing rows already saved with `author = 'ben'` or `author = 'user'` are left as-is. They're a historical record of who actually replied at the time; only new replies use the resolved name.

## Data model

New table, added identically (same SQL) to both schema-init blocks — `lib/database.ts`'s `initSchema()` (after the `comment_replies` block, `lib/database.ts:219-228`) and `claude_reviewer/database.py`'s `SCHEMA_SQL` (after the equivalent block, `database.py:127-137`):

```sql
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Two keys used by this feature: `reply_author_name`, `reply_author_email`. No new index needed (PK lookup by key is already O(log n) on a tiny table).

## Effective-value resolution helper

One new module per side, both implementing the identical rule:

- **TS**: `lib/settings.ts` — exports `getEffectiveReplyAuthor(): { name: string; nameSource: 'saved' | 'git' | 'default'; email: string | null; emailSource: 'saved' | 'git' | 'none' }` and `saveReplyAuthor(name: string, email: string)`. Reads/writes the `settings` table via `getDatabase()` (same pattern as existing `lib/database.ts` functions — this module lives alongside it and imports `getDatabase`/`checkpoint` from it, or the two `get`/`set` primitives get added directly to `lib/database.ts` as `getSetting(key)`/`setSetting(key, value)` and `lib/settings.ts` only holds the resolution + git-prefill logic). Git prefill: a new `getGitUserIdentity()` in `lib/git.ts`, `execFileSync('git', ['config', '--global', '--get', 'user.name'])` / `'user.email'`, each wrapped in try/catch returning `null` on failure (unset config, git not installed) — same defensive style as `blameCommit` (`lib/git.ts:77-92`).
- **Python**: mirrored `get_setting(key)`/`set_setting(key, value)` added to `claude_reviewer/database.py` near `add_reply` (uses the existing `get_connection()` context manager, upsert via `INSERT ... ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`), plus `get_effective_reply_author()` that applies the same fallback rule, calling a new `get_global_git_user()` in `claude_reviewer/git_ops.py` (a module-level function, not a `GitOps` method, since it isn't tied to any specific repo — shells out via `subprocess.run(["git", "config", "--global", "--get", "user.name"])`, returns `None` on non-zero exit).

## API surface (web)

New `app/api/settings/route.ts`, following the try/catch + `NextResponse.json` conventions in `app/api/prs/[id]/comments/route.ts`:

- **GET** — calls `getEffectiveReplyAuthor()`, returns the shape above as JSON. No params.
- **PUT** — body `{ name: string, email: string }`. 400 if `name` trims to empty. Calls `saveReplyAuthor(name.trim(), email.trim())`, returns `{ success: true }`.

## Settings page (web)

- New `app/settings/page.tsx`, a client component following the existing pages' data-fetch-on-mount + local-state-form pattern.
- New nav entry in `components/HeaderNav.tsx` (after the "Conversations" link): a `Settings` (gear) icon from `lucide-react`, `href="/settings"`, added to the `isActive` logic the same way `/browse` is (`pathname.startsWith('/settings')`).
- Layout: one `<section>` titled "Reviewer Identity" containing Name and Email text inputs, prefilled from `GET /api/settings` on mount (using the resolved `name`/`email` regardless of source — the field just shows the effective value, editable). A small inline hint (e.g. "from git config") renders next to a field when its `*Source === 'git'`, so the user knows it's a live prefill they haven't explicitly saved yet. Save button calls `PUT /api/settings` with the current field values; on success, re-fetches to confirm the row is now `'saved'` (hint disappears). This section is structured so a future setting becomes another `<section>` on the same page without restructuring.

## Reply-flow wiring

Both existing hardcoded call sites switch to the resolved name, fetched once per page (e.g. on mount, stored in component state) rather than re-fetched per keystroke/submit:

- `app/prs/[id]/page.tsx`: `addReply()` (lines 560-628) — `tempReply.author` (566) and the POST body's `author` (590) both use the fetched effective name instead of the literal `'ben'`.
- `app/browse/page.tsx`: `addComment()` (361-392) and `addReply()` (394-...) — the `author: 'user'` literals (373, 403) become the fetched effective name.

Both files call `GET /api/settings` once (e.g. in an existing top-level `useEffect` that already runs on mount, alongside whatever else each page already loads) and keep just the resolved `name` string in state for use at reply/comment-submit time. If the fetch fails for any reason, fall back to the literal `"reviewer"` client-side so replying never breaks.

## CLI wiring

- `cli.py`'s `reply` command (`:928-947`): `--author` default stays `"claude"`. Before calling `db.add_reply(comment_uuid, message, author)`, if `author == "me"`, replace it with `db.get_effective_reply_author()["name"]`.
- No change to the automated call at `cli.py:1533` (`db.add_reply(comment.uuid, response, author="claude")`).

## Edge cases

- **No git config at all** (git not installed, or `user.name` never set): `getGitUserIdentity()`/`get_global_git_user()` return `None`/`null`; effective name falls back to `"reviewer"`, email stays unset. Settings page shows empty/default fields with no "from git" hint (nothing to attribute the prefill to).
- **Docker deployment** (`HOST_PATH_PREFIX` set, per `lib/git.ts:21-27`): `git config --global` reads the container's own global config, not necessarily the host user's `~/.gitconfig`, unless that's bind-mounted separately. Not addressed by this design — same class of limitation as other host-vs-container path handling already in the codebase.
- **Saved empty email**: treated as an explicit "no email", not as "unset" — does not fall back to git on subsequent loads (see resolution rule above).
- **Concurrent web + CLI writes to `settings`**: same WAL + `busy_timeout` concurrency handling already relied on for every other shared table; no new handling needed.
- **Existing replies with `author = 'ben'`/`'user'`**: continue to render under the `reply-human` (renamed from `reply-ben`) style, since they aren't `'claude'` — no data migration needed.

## Testing / verification

- Vitest unit tests for `getSetting`/`setSetting` (or wherever the primitives land) and `getEffectiveReplyAuthor()` in `lib/settings.ts`, following `__tests__/database.test.ts`'s direct-function-call pattern; a test for `getGitUserIdentity()` following `__tests__/git.test.ts`'s temp-repo-with-`git config`-set convention (already used there to set up fixtures) plus a case with no git config reachable.
- Python tests for `get_setting`/`set_setting`/`get_effective_reply_author()` and the `me` sentinel in `reply`, added to `claude-reviewer-cli/tests/test_database.py` and `test_cli.py` following their existing patterns; a `get_global_git_user()` test in `test_git_ops.py`.
- `npx tsc --noEmit`.
- Manual pass: visit `/settings` with a machine that has `git config user.name` set — confirm prefill + hint; save an override — confirm hint disappears and the value persists across reload; post a PR comment reply and a repo-conversation reply/comment — confirm the configured name (not `'ben'`/`'user'`) appears and gets the `reply-human` styling; from a terminal, run `claude-reviewer reply <pr> <comment> "msg" --author me` — confirm it posts under the configured name; run the documented Claude workflow's `claude-reviewer reply` with no `--author` — confirm it's still `"claude"`.
