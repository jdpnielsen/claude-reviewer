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
3. Check whether the web UI is reachable with `claude-reviewer serve --check` (no
   side effects — it only reports, exit 0 means running, exit 1 means not). Whether
   to actually *start* it is the human's call, not yours: never run plain
   `claude-reviewer serve` on their behalf. If the check comes back not-running, ask
   them to run it before you hand over a URL.

## The review loop

```bash
# 1. Make the change on a feature branch, commit it
git checkout -b feature/my-change
# ...edit...
git add -A && git commit -m "Add the thing"

# 2. Open a PR for review
claude-reviewer create --title "Add the thing" --base main
# -> PR #a1b2c3d4 created. Review URL: http://localhost:41729/prs/a1b2c3d4

# 2b. Before handing that URL over, confirm it'll actually load
claude-reviewer serve --check || echo "ask the human to run: claude-reviewer serve"

# 3. Block until the human responds (approval or changes requested)
claude-reviewer watch a1b2c3d4
# prints the requested comments automatically if changes were requested

# 4. Read every comment, including ones `watch` already printed
claude-reviewer comments a1b2c3d4 --unresolved
# a comment may include a suggested change - see below

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

### Suggested changes

A reviewer can propose exact replacement code for the lines a comment is anchored to,
GitHub-style, instead of just describing the fix in prose — and a single comment can
contain more than one suggestion fence. `comments` renders each as a labeled,
syntax-highlighted block instead of raw fenced markdown; with `-f json` they're also
broken out as a `suggestions` field (a list of proposed-line-lists, empty if the
comment has none) so you don't have to re-parse the text yourself. Treat it like any
other feedback: apply the suggested code with your own edit tools, then `reply`
explaining what you did (or why you did something different) before `update`. There's
no separate "apply" command — the CLI only surfaces suggestions, it doesn't touch
files.

### Resolution mode: not every comment means "fix it"

Each comment carries a resolution mode the reviewer picked when they wrote it, shown
as a tag in `comments` output (omitted for the default, so most comments show no
tag at all) and as a `resolution_mode` field with `-f json`:

- **no tag / `fix`** — implement it, the default and by far the most common case.
- **`[discuss]`** — don't touch the code yet. `reply` with your view, a question, or
  a counter-proposal, and leave the thread unresolved until the reviewer responds.
- **`[fix-if-agreed]`** — implement it if you agree; if you don't, `reply` explaining
  why not and leave it unresolved rather than either silently skipping it or making a
  change you disagree with.

Only `fix` should ever be treated as an unconditional mandate. Getting a `discuss` or
`fix-if-agreed` comment right is worth more than getting to `update` faster.

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
| `comments <id> [--unresolved] [-f json]` | Inline comments as `file:line` + text; renders/reports a suggested change if present; tags non-default resolution modes (`[discuss]`/`[fix-if-agreed]`). |
| `reply <id> <comment-uuid> "text" [-a author]` | Explain what you did about a comment. `-a` defaults to `claude`; use `-a me` to reply as the configured human reviewer instead, or `-a <name>` for any other registered author. |
| `authors list` / `add <name> --kind human\|agent` / `edit <name>` / `remove <name>` / `set-default <name>` | Manage the roster of reviewer/agent identities replies get attributed to. |
| `update <id> [-t title] [-b base] [-h head]` | Re-diff after new commits; resets status to pending. `-t` retitles the PR, `-b` retargets it at a new base branch, `-h` repoints it at a new head branch; either re-diffs and relocates comments. Refs are validated first, and base can't equal head. |
| `watch <id> [--until ...]` | Block until feedback arrives. Default `--until feedback_given`. |
| `watch-all [--fix] [--once]` | Auto-respond to every unanswered PR comment + Browse conversation. |
| `merge <id> [--delete-branch] [--no-push]` | Merge once approved. |
| `close <id>` / `delete <id>` | Abandon a PR without merging / wipe it entirely. |
| `serve [--local\|--dev] [-p port]` | Start the web UI (default port 41729). Only ever suggest this to the human, don't run it yourself. |
| `serve --check [-p port]` | Report whether the web UI is reachable; exits 0/1, starts nothing. Safe to run yourself. |
| `open [id] [-p port]` | Open the dashboard (or PR `id`) in a browser if the web UI is already running; otherwise reports that and suggests `serve` — never starts anything itself. Popping open a browser tab is still visible on the human's screen, so only run this when they've explicitly asked you to open/show the review UI. |
| `stop` | Stop the web UI. |

Full flag list: `claude-reviewer <command> --help`.

## Things that trip people up

- **"Not a git repository" / base==head error**: you're on `main` with nothing to
  diff, or tried to PR a branch against itself. Create a feature branch first.
- **PR created but review URL 404s**: `serve --check` would have caught this — run
  it before handing over any URL, not just after a 404 report. Either way, don't
  start the server yourself; ask the human to run `claude-reviewer serve` (or
  `serve --dev` from this source checkout). Spinning up a local server/container on
  their machine is their decision to make, not yours.
- **Human says `serve` errored with "Port already in use"**: that's not a real
  error — it means the web UI was already running. Reassure them, no action needed.
- **Server was running last session but isn't now**: web UI containers/processes
  don't survive a reboot or a `docker system prune`. `watch`/`comments`/`list` keep
  working fine in this case — they talk to SQLite directly, not the server — which is
  exactly why "the CLI works" doesn't mean the review link does. `serve --check` is
  the one command that actually answers the question; run it if in doubt.
- **`update` didn't pick up your fix**: `update` diffs `base_ref..head_ref` from git,
  not from memory — make sure the fix is actually committed, not just staged.
- **PR was opened against the wrong base or head branch, or the title no longer
  fits**: don't close and recreate it (you'd lose the comments) — `update <id>
  -b <base>` / `-h <head>` / `-t "New title"` fixes any of them in place, keeping
  the review thread. `-h` is the one to reach for when the work was redone on a
  fresh branch and you want the existing review to follow it.
- **Merge refuses**: only `approved` PRs merge. If status is still `pending`, nobody
  has reviewed it yet; if `changes_requested`, address the comments and `update` first.
- **Comments reference a deleted line**: old-side comments anchor to the diff's
  "before" tree, which may no longer exist in the working tree — `comments` still
  shows the right `file:line`, trust that over grepping the current file.
- **PR's repository/worktree was deleted under it**: a PR created inside a throwaway
  worktree keeps pointing at that path, so once it's removed nothing git-backed works
  — no `update`, no `merge`, and the web UI shows the PR read-only with a banner
  saying so. A PR's `repo_path` is fixed at `create` time and no flag rewrites it
  (`update -r` only redirects that one invocation's git calls), so the fix is
  `delete <id>` and, if the work still needs review, `create` again from a live
  checkout. There's a Delete button on the PR page too, which works in this state.
  Best avoided: clean the PR up when you tear its worktree down.

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
shared working tree. Remember that the PR outlives the worktree, and its recorded
repo path can't be moved afterwards: merge or `delete` each PR before tearing its
worktree down.
