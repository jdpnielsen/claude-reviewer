---
name: claude-reviewer-always
description: Use this BEFORE declaring any non-trivial coding task complete, before `git push`, before opening a GitHub pull request, or before merging a feature branch into main/master — ask the user whether to open a local claude-reviewer PR for review first, instead of treating the diff as already trustworthy. Trigger on finishing a feature, bugfix, or refactor that touches more than a couple of lines, wrapping up a multi-file change, or any point where you'd otherwise just say "done, ready to merge." Skip only for one-off throwaway scripts or exploratory edits nobody will look at again. This is the standing-habit companion to the `claude-reviewer` skill (which does the actual create/watch/reply mechanics) — install this one at the user level (`~/.claude/skills`) so it applies across every project, not just ones that spell it out in their CLAUDE.md.
---

# claude-reviewer-always: default to a review checkpoint

Most "AI wrote 40 files and I skimmed it, LGTM" incidents happen because there's no
natural pause between "the agent finished" and "the code is trusted." This skill *is*
that pause. It doesn't do the review itself — it makes sure the question gets asked
before code slides past you into main or into a GitHub PR your collaborators will see.

The habit: **finish the work, then stop and ask, before declaring victory or pushing
anything.** Don't wait for the user to remember claude-reviewer exists.

## When to actually ask

Ask when the change is heading somewhere that matters:

- going to production, or on a path that eventually will
- touched by, or visible to, more than one person
- likely to be maintained past this conversation
- about to be pushed, PR'd on GitHub, or merged into a shared branch

Don't ask (just proceed) when it's clearly disposable:

- a one-off script or throwaway repro you're about to delete
- pure exploration/spike work the user explicitly framed as "just try something"
- the user already said "skip review" for this task — don't re-litigate it on every
  follow-up message in the same task; a fresh ask is only warranted for the *next*
  distinct piece of work

When genuinely unsure which bucket it's in, ask — a skipped review is cheap to redo,
a merged mistake isn't.

## What to check before asking

1. **Is claude-reviewer even available?** `command -v claude-reviewer` (or check for
   it having been used earlier in this session/repo). If it's not installed, don't
   block on it — mention it once ("I can set up a local review checkpoint with
   claude-reviewer, want me to?") and fall back to whatever the user's normal flow is
   if they'd rather not install anything right now.
2. **Is the web UI actually running, not just the CLI installed?** The CLI working
   (`list`, `status`, `comments` all talk straight to SQLite) says nothing about
   whether the web server is up — and a dead review link is worse than not asking at
   all. Start it quietly before you ask: `claude-reviewer serve` (`--dev` from a
   source checkout). A "Port already in use" error just means it's already running —
   treat that as success, not something to fix.
3. **Is there already an open PR for this branch?** `claude-reviewer list -s pending`
   and `claude-reviewer list -s changes_requested` (both auto-scope to the current
   repo). If one exists, don't ask to create a new one — say so and offer to `update`
   the existing PR instead.
4. **Is the change actually committed?** claude-reviewer diffs `base..head` from git,
   not the working tree. Commit first if you haven't.

## How to ask

Keep it to one line, at the natural end of the turn — not a wall of justification:

> "This touches auth handling across 4 files — want me to open a claude-reviewer PR
> for local review before we go further?"

If yes, hand off to the **`claude-reviewer`** skill for the actual mechanics
(create → watch → comments → reply → update → merge). Don't duplicate that command
reference here.

If no, proceed with whatever the user asked for next (commit as-is, push, open the
GitHub PR directly, etc.) without nagging again for this same unit of work.

## Why local review before GitHub, specifically

If the eventual destination is a GitHub PR, treat claude-reviewer as the pre-flight
gate, not a replacement: iterate locally first, let the human catch the "wrong
approach, try again" round trips in private, then push the *polished* result as the
GitHub PR. Collaborators see the reviewed diff, not the seventeen attempts it took to
get there. This is also why `--delete-branch` on `claude-reviewer merge` matters less
than getting the *content* right before it's public — clean up the local PR trail
without worrying about preserving it as history.

## Failure mode to avoid

Don't turn this into review-theater: asking the question and then merging on `pending`
status anyway, or treating "I opened a PR" as equivalent to "it was reviewed." The
point is the human's comments and an explicit `approved` status — if they haven't
looked yet, the work isn't done, it's just parked.
