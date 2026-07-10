---
name: claude-reviewer
description: Run a local, offline PR review cycle with the claude-reviewer CLI instead of pushing straight to a GitHub PR. Use this whenever the user asks to "open/create a claude-reviewer PR," "get this reviewed locally," "check the review status/comments," "address the review feedback," "update the PR," or "merge the PR" — or whenever you've just finished a feature branch and need a human review checkpoint before it goes further. Covers create/watch/comments/reply/update/merge plus the web UI (serve/stop) and multi-agent usage. Requires the `claude-reviewer` CLI (pip install claude-reviewer) and a git repo on a feature branch (not main).
---

# claude-reviewer: local PR review cycle

`claude-reviewer` is GitHub-style PR review that never leaves the machine: a local
SQLite-backed web UI at `localhost:41729` where a human leaves inline comments on a
diff, and you (Claude) read and address them from the terminal. Nothing is pushed
anywhere until the human approves and you merge.

The point isn't ceremony — it's a checkpoint between "AI generated this" and "this is
now in the codebase." Treat your own diff the way you'd want a junior engineer's diff
treated: it needs a second pair of eyes before it's trusted, not because the code is
presumed bad, but because nobody has looked yet.

**Skip this for**: one-off scripts, throwaway exploration, or anything you're about to
discard anyway. There's no point staging a review for code nobody will read again.

**Use this for**: anything headed for production, anything more than one person will
touch, anything that will outlive this conversation.

## Before you start

1. Confirm you're on a feature branch, not `main`/`master` — a PR can't have the same
   head and base branch.
2. Confirm there's something to review: `git status` should show committed changes
   that differ from the base branch. Uncommitted changes don't show up in the diff.
3. Make sure the web UI is actually reachable, not just installed. `create` succeeds
   either way — a PR is just a database row — and prints a warning if it can't see a
   server, but don't count on catching that warning mid-flow. Proactively run
   `claude-reviewer serve` (or `claude-reviewer serve --dev` if you're working from
   this source checkout) before or right after `create`. If it's already running,
   `serve` exits with a "Port already in use" error — that's the expected signal that
   you're set, not a failure to work around by picking a different port.

## The review loop

```bash
# 1. Make the change on a feature branch, commit it
git checkout -b feature/my-change
# ...edit...
git add -A && git commit -m "Add the thing"

# 2. Open a PR for review
claude-reviewer create --title "Add the thing" --base main
# -> PR #a1b2c3d4 created. Review URL: http://localhost:41729/prs/a1b2c3d4

# 2b. Make sure the human can actually load that URL — start the web UI if it's
# not already up. "Port already in use" here just means it's already running.
claude-reviewer serve

# 3. Block until the human responds (approval or changes requested)
claude-reviewer watch a1b2c3d4
# prints the requested comments automatically if changes were requested

# 4. Read every comment, including ones `watch` already printed
claude-reviewer comments a1b2c3d4 --unresolved

# 5. Make the fixes, commit them
git add -A && git commit -m "Address review feedback"

# 6. Tell the reviewer what you changed, per comment
claude-reviewer reply a1b2c3d4 <comment-uuid> "Fixed by validating the token before use"

# 7. Push the new diff into the same PR (this resets status to pending)
claude-reviewer update a1b2c3d4

# 8. Loop back to step 3 until status is "approved"
claude-reviewer status a1b2c3d4

# 9. Merge — only works once approved
claude-reviewer merge a1b2c3d4 --delete-branch
```

Reply to *every* unresolved comment before calling `update`, even ones you disagree
with — say why instead of silently ignoring them. A reviewer who gets ignored stops
leaving comments.

### If asked to iterate without blocking

`watch` parks the terminal until something changes, which is right when a human is
actively reviewing right now. If you were told to keep working and come back later,
poll instead:

```bash
claude-reviewer status a1b2c3d4                    # pending | approved | changes_requested
claude-reviewer comments a1b2c3d4 -f json           # machine-readable, for scripting
```

### Async / fire-and-forget mode

If the human said they'll leave comments whenever and you should just handle them as
they come in, use `watch-all --fix` instead of the manual reply/update loop — it polls
every PR and every Browse conversation in the repo, drafts a response with `claude -p`,
edits files to address feedback, commits, and updates the PR diff automatically:

```bash
claude-reviewer watch-all --fix          # keeps polling
claude-reviewer watch-all --fix --once   # one pass, for a script/cron
```

Only reach for this when the human has explicitly signed off on autonomous edits —
it uses `--dangerously-skip-permissions` under the hood.

## Command reference

| Command | What it does |
|---|---|
| `create -t "Title" [-b base] [-h head]` | Open a PR from the current diff. Base/head auto-detect if omitted. |
| `list [-s status] [--all]` | List PRs (current repo only unless `--all`). |
| `status <id>` | `pending` / `approved` / `changes_requested` / `merged` / `closed`. |
| `show <id>` | Full PR detail + diff preview. |
| `comments <id> [--unresolved] [-f json]` | Inline comments as `file:line` + text. |
| `reply <id> <comment-uuid> "text"` | Explain what you did about a comment. |
| `update <id>` | Re-diff after new commits; resets status to pending. |
| `watch <id> [--until ...]` | Block until feedback arrives. Default `--until feedback_given`. |
| `watch-all [--fix] [--once]` | Auto-respond to every unanswered PR comment + Browse conversation. |
| `merge <id> [--delete-branch] [--no-push]` | Merge once approved. |
| `close <id>` / `delete <id>` | Abandon a PR without merging / wipe it entirely. |
| `serve [--local\|--dev] [-p port]` | Start the web UI (default port 41729). |
| `stop` | Stop the web UI. |

Full flag list: `claude-reviewer <command> --help`.

## Things that trip people up

- **"Not a git repository" / base==head error**: you're on `main` with nothing to
  diff, or tried to PR a branch against itself. Create a feature branch first.
- **PR created but review URL 404s**: the web UI isn't running yet. Don't just rely
  on `create`'s warning — run `claude-reviewer serve` (or `serve --dev` from this
  source checkout) yourself before handing the URL over, and reload.
- **`serve` exits with "Port already in use"**: that's not an error to fix — it means
  the web UI is already up on that port. Move on, don't restart it or pick a new port.
- **Server was running last session but isn't now**: web UI containers/processes
  don't survive a reboot or a `docker system prune`. If `watch`/`comments` still work
  (they talk to SQLite directly, not the server) but the review URL is dead, that's
  the tell — `serve` again.
- **`update` didn't pick up your fix**: `update` diffs `base_ref..head_ref` from git,
  not from memory — make sure the fix is actually committed, not just staged.
- **Merge refuses**: only `approved` PRs merge. If status is still `pending`, nobody
  has reviewed it yet; if `changes_requested`, address the comments and `update` first.
- **Comments reference a deleted line**: old-side comments anchor to the diff's
  "before" tree, which may no longer exist in the working tree — `comments` still
  shows the right `file:line`, trust that over grepping the current file.

## Multiple PRs / multiple agents at once

Each PR is independent, so parallel work is just parallel terminals or parallel Claude
sessions, each on its own branch and PR id — the human reviews all of them from the
same `localhost:41729` dashboard:

```bash
# terminal / agent 1
claude-reviewer create -t "Auth" -b main -h feature/auth
claude-reviewer watch <auth-pr-id>

# terminal / agent 2
claude-reviewer create -t "API" -b main -h feature/api
claude-reviewer watch <api-pr-id>
```

If this session is one of several concurrent agents on the same checkout, prefer a
git worktree per branch so `create`/`update` don't race on uncommitted changes in a
shared working tree.
