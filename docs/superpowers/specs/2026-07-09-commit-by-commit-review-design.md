# Commit-by-commit review

## Context

Today a PR is reviewed as one cumulative `base...head` diff (`diff_snapshots.diff_content`, captured by the CLI at `create`/`update` time and displayed as-is by the web UI). Reviewers have asked to also review a PR one commit at a time, GitHub-"Commits tab"-style, without losing the cumulative view.

This has come up twice before as a forward-looking concern (during the removed-line-comment and multi-line-comment work) but was never designed:

- PRs store only a single `base_commit`/`head_commit` pair — no per-commit concept exists anywhere.
- `claude-reviewer-cli/claude_reviewer/git_ops.py` already has `get_commits_between(base, head)` (returns sha/short_sha/message/author/date), built and tested but never called from anywhere.
- Comments anchor to `(file_path, line_number, end_line_number, line_type)` with no notion of which commit or diff revision they were made against.
- This repo now has an established idempotent-migration pattern (`migrateCommentsEndLine` / `_migrate_comments_end_line`) for schema changes, added for multi-line comments.

**Correction of an earlier assumption made mid-design**: the web server (Next.js) is not DB-only — `app/api/prs/[id]/context/route.ts` already shells out to live `git show <commit>:<file>` against `pr.repo_path`, with a `translatePath()` helper that remaps host paths to a Docker bind mount (`HOST_PATH_PREFIX=/host-home`, see `docker-compose.yml`) when running in a container. Per-commit diffs can reuse this exact pattern instead of requiring new CLI-side precomputation.

## Decisions made during brainstorming

- **Interaction model**: add a commit selector alongside the existing cumulative view (GitHub's model), not a replacement. Cumulative stays the default when a PR is opened.
- **Comment scoping**: a comment belongs to the commit it was made against. A comment made while viewing commit A's diff is tagged with that commit's SHA and only appears in that commit's view (plus a PR-wide "all comments" rollup — comments are never hidden, only scoped for inline display). A comment made while viewing "all commits" (cumulative) gets no commit tag and only appears in the cumulative view.
- **Scope**: full feature — web UI, CLI comment display, and AI auto-review all become commit-aware in this pass.
- **AI auto-review**: stays a single pass over the cumulative diff (full-PR context, one API call), but each posted comment is tagged with whichever commit last touched that line via `git blame`, restricted to commits within the PR's range.
- **Diff generation**: live via git in the web server (approach A below), not precomputed/stored by the CLI.

### Approaches considered for diff generation

**A. Live git generation in the web server (chosen).** New code shells out to `git log`/`git diff`/`git blame` against the (Docker-translated) `repo_path`, the same pattern `context/route.ts` already uses. No new tables for commits or per-commit diffs, no CLI changes. Relies on raw commit SHAs staying resolvable via git — already a load-bearing assumption for the existing `context` and `browse` features.

**B. Precompute and store at `create`/`update` time (CLI-side)**, mirroring `diff_snapshots`. Rejected: needs a new versioned table, new CLI code, and a rebase/force-push story for freezing stale per-commit diffs — meaningful new machinery to duplicate something git already answers on demand, with no corresponding new capability (nothing in this app tries to survive the repo disappearing today).

## Data model

Add one nullable column, following the `end_line_number` migration pattern exactly:

- `comments.commit_sha TEXT` (nullable) in both `lib/database.ts` and `claude_reviewer/database.py`.
  - `NULL` means "scoped to the cumulative view" — true for every existing comment and for any new comment made while viewing "all commits."
  - `lib/database.ts`: add the column to the fresh-install DDL, add `commit_sha: string | null` to the `Comment` interface, add `migrateCommentsCommitSha(db)` (same idempotent `PRAGMA table_info` + `ALTER TABLE` + duplicate-column catch as `migrateCommentsEndLine`), called at the end of `initSchema()`. No backfill needed (`NULL` is already correct for old rows).
  - `claude_reviewer/database.py`: same shape — column in `SCHEMA_SQL`, `_migrate_comments_commit_sha(conn)` called from `init_db()`, `commit_sha: Optional[str] = None` added to the `Comment` dataclass, `commit_sha=row["commit_sha"]` added to `_row_to_comment()` (it enumerates fields explicitly — the same omission bit `end_line_number` before).
  - `addComment()`/`add_comment()` get a new optional trailing param (`commitSha` / `commit_sha`, default `null`/`None`). Every existing call site (AI-review's 4-arg call, the multi-line-comment 6-arg call, tests) is unaffected.

No other schema changes. Commits and per-commit diffs are not stored anywhere — they're derived live from git on each request.

## Backend

**New shared helper — `lib/git.ts`** (new file), used by both the commits/diff endpoint and the AI-review route:

- `resolveRepoPath(repoPath: string): string` — extracted from `context/route.ts`'s `translatePath()` (the correct implementation for this Docker setup — see note below). Moves to a shared location instead of being pasted a third time.
- `listCommits(repoPath: string, baseCommit: string, headCommit: string): CommitInfo[]` — `git log --format=... <baseCommit>..<headCommit>`, returning `{ sha, shortSha, message, author, date }` per commit, oldest-first.
- `getCommitDiff(repoPath: string, sha: string): string` — the diff for a single commit against its first parent (`git diff <sha>^..<sha>`, or equivalent), degrading gracefully rather than crashing on the rare merge-commit-in-range case.
- `blameCommit(repoPath: string, headCommit: string, filePath: string, line: number): string | null` — `git blame` for a single line at `headCommit`, used only by AI auto-review's commit-attribution step.

**Note on `translatePath`**: it currently exists twice and disagrees with itself. `context/route.ts`'s version strips a `/Users/<user>/` prefix and joins with `HOST_PATH_PREFIX` — correct for this repo's `docker-compose.yml`, which bind-mounts `~/` to `/host-home`. `app/api/browse/file/route.ts`'s inline version instead replaces a `/app/repo` prefix, which doesn't correspond to anything in the current Docker setup and looks like leftover logic from an earlier iteration. This spec extracts and reuses the `context/route.ts` version; the `browse/file/route.ts` divergence is a pre-existing bug worth its own separate fix, out of scope here.

**API**:

- `GET /api/prs/[id]` gains an optional `?commit=<sha>` query param and an always-present `commits` field:
  - `commits`: `listCommits(repoPath, pr.base_commit, pr.head_commit)` — always included, drives the selector.
  - When `?commit=<sha>` is given: `diff` = `getCommitDiff(repoPath, sha)` instead of `getLatestDiff()`; `files` = `parseDiffFiles()` of that diff (existing function, unchanged). Falls back to the current cumulative behavior when the param is absent.
  - `comments` is unchanged — always the full PR comment set (`getCommentsWithReplies`); the frontend filters by `commit_sha` for inline display, so the "all comments" list never has to make a second request.
- `POST /api/prs/[id]/comments` gains an optional `commitSha` field in the body, threaded through to `addComment()`. No validation beyond existing checks — an unrecognized SHA just means the comment won't match any commit in a future `listCommits()` call (see rebase handling below), the same way an existing comment can already go stale if a line moves.

**AI auto-review** (`app/api/prs/[id]/ai-review/route.ts`): after Claude returns `{file_path, line_number, content}` comments against the cumulative diff (unchanged prompt/parsing), for each comment:
1. Compute `commits = listCommits(repoPath, pr.base_commit, pr.head_commit)` once.
2. `blameCommit(repoPath, pr.head_commit, file_path, line_number)` to find the commit that last touched that line.
3. If that SHA is in `commits`, pass it as `commitSha` to `addComment()`. If it's not (the blamed commit predates the PR — Claude commented on an unchanged context line), leave `commitSha` unset, so the comment falls back to cumulative scope. Never fails the whole review pass if blame can't resolve a given line — that comment just gets no commit tag.

## Frontend (`app/prs/[id]/page.tsx`)

- New state: `selectedCommit: string | null` (`null` = cumulative/"All commits"), alongside the existing `commentingAt`/`expandedFiles` state.
- A commit list/selector (sha, short message, author) rendered from the `commits` field already returned by the PR detail fetch. Selecting a commit re-fetches `GET /api/prs/[id]?commit=<sha>` and re-renders the same diff-parsing/rendering path already used for the cumulative view — no new rendering logic, just a different diff string and file list feeding the existing code.
- Comment filtering: inline display (thread-render + highlight predicates already built for multi-line comments) additionally requires `comment.commit_sha === selectedCommit` (both `null` when viewing cumulative).
- New comments pick up `commitSha: selectedCommit` when POSTing, alongside the existing `lineNumber`/`endLineNumber`/`lineType`.
- The sidebar's unresolved-comment count (`unresolvedCount`, `page.tsx:683`) is computed from the full PR comment set already, not the currently-selected view — no change needed, it stays accurate regardless of `selectedCommit`.

## CLI (`claude_reviewer/cli.py`)

- `print_comment()`: append a commit indicator next to the existing `[old-side]`/`[resolved]` dim tags — short SHA when `commit_sha` is set (e.g. `[abc1234]`), nothing when `None` (cumulative), matching the existing terse dim-tag style.
- `comments --format json`: add a `"commit_sha": c.commit_sha` key alongside the existing `"line"`/`"end_line"` keys.
- No new CLI commands or flags — commit-by-commit browsing is a web UI concern; the CLI only needs to surface which commit a comment belongs to.

## Edge cases / backward compatibility

- **Pre-existing comments**: all have `commit_sha = NULL`, unchanged behavior — visible only in the cumulative view, exactly as today.
- **Rebase / force-push (`claude-reviewer update` with rewritten history)**: `listCommits()` is computed live from the current `base_commit`/`head_commit`, so old commit SHAs that no longer exist in range simply won't match any entry. Comments tagged with those SHAs stop appearing inline in any commit view or the cumulative view. There is no dedicated "all comments" panel in the web UI today (only a sidebar unresolved-count and per-line inline threads), so such a comment becomes reachable only via `claude-reviewer comments <pr-id>` (which shows every comment unconditionally) until someone re-selects a matching commit — this is the same pre-existing gap that already applies to any comment whose line drifts after a cumulative-diff update, not a new limitation introduced here. No new orphan-tracking (unlike `repo_conversations`' `status`/`file_exists` machinery) is needed, since nothing is deleted, just no longer inline-anchored.
- **Merge commits within the PR range**: diffed against first parent; degrades to "less precise diff for that one commit," never a crash.
- **Single-commit PRs**: the selector still shows one entry; selecting it produces output identical to the cumulative view. No special-casing required.
- **AI auto-review blame miss**: falls back to cumulative scope (see above), never blocks the review pass.

## Testing / verification

1. `npx tsc --noEmit`; `mypy claude_reviewer`, `ruff`, `black`, `isort` via the pipx venv (`~/.local/pipx/venvs/claude-reviewer/bin/...`).
2. New Jest tests for `lib/git.ts` (`listCommits`, `getCommitDiff`) against a temp git repo fixture, mirroring the existing temp-repo pattern in `claude-reviewer-cli/tests/test_git_ops.py`'s `test_get_commits_between`.
3. `npm test` / `pytest tests/` — existing suites unaffected (new optional params, no signature breaks).
4. `npm run build && PORT=41729 npm run start`, manual pass against a real multi-commit PR:
   - Open a PR, confirm cumulative view is still the default.
   - Switch through each commit in the selector; diff content changes accordingly.
   - Comment while viewing commit A; confirm it appears only under commit A and in the all-comments list, not under commit B or cumulative.
   - Comment while viewing "All commits"; confirm it appears only in the cumulative view.
   - Run AI auto-review; spot-check that at least one posted comment is tagged with a specific commit and shows up correctly scoped.
   - `claude-reviewer comments <pr-id>` and `--format json` show the commit tag.
