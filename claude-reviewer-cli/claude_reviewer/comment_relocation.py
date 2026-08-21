"""Re-anchor a PR's comments after a sync (rebase/amend/force-push) changed
commit SHAs and/or shifted line content.

Mirrors lib/comment-relocation.ts (the web app's equivalent) - kept as a
separate implementation rather than shared code since the two sides don't
share a runtime, but the algorithm, search radius, and blob-resolution rules
are kept identical.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .database import apply_comment_relocations, get_comments, upsert_commit_relocation
from .git_ops import CommitCorrespondence, compute_commit_correspondence, get_file_at_commit
from .models import Comment, CommentRelocationStatus, CommentRelocationUpdate

_SEARCH_RADIUS = 50


def _relocate_line(
    anchor_content: str,
    original_line: int,
    context_before: str | None,
    context_after: str | None,
    lines: list[str],
) -> int | None:
    """Exact original line, then a +/- search-radius exact match, then a
    context-window match - same three-tier algorithm as
    app/api/browse/file/route.ts's relocateAnchor.
    """
    anchor_trimmed = anchor_content.strip()

    if 0 < original_line <= len(lines) and lines[original_line - 1].strip() == anchor_trimmed:
        return original_line

    start_search = max(0, original_line - _SEARCH_RADIUS)
    end_search = min(len(lines), original_line + _SEARCH_RADIUS)

    for i in range(start_search, end_search):
        if lines[i].strip() == anchor_trimmed:
            return i + 1

    before_lines = [line.strip() for line in context_before.split("\n")] if context_before else []
    after_lines = [line.strip() for line in context_after.split("\n")] if context_after else []

    if before_lines or after_lines:
        for i in range(start_search, end_search):
            matches = True

            for j, before in enumerate(before_lines):
                if not matches:
                    break
                check_idx = i - len(before_lines) + j
                if check_idx < 0 or check_idx >= len(lines) or lines[check_idx].strip() != before:
                    matches = False

            for j, after in enumerate(after_lines):
                if not matches:
                    break
                check_idx = i + 1 + j
                if check_idx >= len(lines) or lines[check_idx].strip() != after:
                    matches = False

            if matches:
                return i + 1

    return None


def _blob_ref(commit_sha: str | None, base: str, head: str, line_type: str) -> str:
    """The commit reference a comment's line_number is measured against: the
    "old" side of a diff is the parent tree (base, or commit_sha^ when
    scoped to a single commit); everything else (line_type "new", or the
    legacy "context" value FileDiffCard no longer writes) is the "new" side.
    """
    if commit_sha:
        return f"{commit_sha}^" if line_type == "old" else commit_sha
    return base if line_type == "old" else head


def _resolve_renamed_path(
    repo_path: str | Path, old_ref: str, new_ref: str, file_path: str
) -> str | None:
    """Best-effort rename detection when the file isn't found at its stored
    path in the new blob - `git diff -M` between the two blob references,
    scoped to this path so unrelated changes elsewhere in the tree don't
    matter.
    """
    try:
        result = subprocess.run(
            ["git", "diff", "--no-color", "-M", "--name-status", old_ref, new_ref, "--", file_path],
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError:
        return None
    for line in result.stdout.strip().splitlines():
        if not line.startswith("R"):
            continue
        parts = line.split("\t")
        if len(parts) == 3 and parts[1] == file_path:
            return parts[2]
    return None


def _orphan_update(comment: Comment, commit_sha: str | None) -> CommentRelocationUpdate | None:
    if comment.status == CommentRelocationStatus.ORPHANED and commit_sha == comment.commit_sha:
        return None
    return CommentRelocationUpdate(
        comment_id=comment.id,
        commit_sha=commit_sha,
        file_path=comment.file_path,
        line_number=comment.line_number,
        end_line_number=comment.end_line_number,
        status=CommentRelocationStatus.ORPHANED,
        paired_line_number=comment.paired_line_number,
        paired_end_line_number=comment.paired_end_line_number,
    )


def _plan_relocation(
    comment: Comment,
    repo_path: str | Path,
    correspondence: CommitCorrespondence,
    old_base: str,
    old_head: str,
    new_base: str,
    new_head: str,
) -> CommentRelocationUpdate | None:
    matched = correspondence["matched"]
    unmatched = correspondence["unmatched"]

    # Commit-message comments: SHA-only relocation, no file/line involved.
    if comment.target_type == "commit_message":
        if not comment.commit_sha:
            return None  # shouldn't happen, nothing to relocate
        new_sha = matched.get(comment.commit_sha)
        if new_sha:
            if new_sha == comment.commit_sha and comment.status == CommentRelocationStatus.ACTIVE:
                return None
            return CommentRelocationUpdate(
                comment_id=comment.id,
                commit_sha=new_sha,
                file_path=comment.file_path,
                line_number=comment.line_number,
                end_line_number=comment.end_line_number,
                status=CommentRelocationStatus.ACTIVE,
                paired_line_number=comment.paired_line_number,
                paired_end_line_number=comment.paired_end_line_number,
            )
        if comment.commit_sha in unmatched:
            return _orphan_update(comment, comment.commit_sha)
        return None  # this comment's commit wasn't part of the range just synced - leave as-is

    # Line comment. Resolve the commit_sha side first, if it's scoped to one.
    target_commit_sha = comment.commit_sha
    if comment.commit_sha:
        new_sha = matched.get(comment.commit_sha)
        if new_sha:
            target_commit_sha = new_sha
        elif comment.commit_sha in unmatched:
            return _orphan_update(comment, comment.commit_sha)
        else:
            return None  # outside this sync's range - leave as-is

    # No stored anchor (a comment from before this feature existed) - only
    # the commit_sha move (if any) applies; line_number is left untouched.
    if not comment.anchor_content:
        if target_commit_sha == comment.commit_sha:
            return None
        return CommentRelocationUpdate(
            comment_id=comment.id,
            commit_sha=target_commit_sha,
            file_path=comment.file_path,
            line_number=comment.line_number,
            end_line_number=comment.end_line_number,
            status=comment.status,
            paired_line_number=comment.paired_line_number,
            paired_end_line_number=comment.paired_end_line_number,
        )

    old_ref = _blob_ref(comment.commit_sha, old_base, old_head, comment.line_type)
    new_ref = _blob_ref(target_commit_sha, new_base, new_head, comment.line_type)

    effective_file_path = comment.file_path
    file_content = get_file_at_commit(repo_path, new_ref, comment.file_path)
    if file_content is None:
        renamed_path = _resolve_renamed_path(repo_path, old_ref, new_ref, comment.file_path)
        if renamed_path:
            renamed_content = get_file_at_commit(repo_path, new_ref, renamed_path)
            if renamed_content is not None:
                file_content = renamed_content
                effective_file_path = renamed_path

    if file_content is None:
        return _orphan_update(comment, target_commit_sha)

    new_line_number = _relocate_line(
        comment.anchor_content,
        comment.line_number,
        comment.anchor_context_before,
        comment.anchor_context_after,
        file_content.split("\n"),
    )

    if new_line_number is None:
        return _orphan_update(comment, target_commit_sha)

    if (
        new_line_number == comment.line_number
        and effective_file_path == comment.file_path
        and target_commit_sha == comment.commit_sha
        and comment.status == CommentRelocationStatus.ACTIVE
    ):
        return None  # nothing actually moved

    delta = new_line_number - comment.line_number
    return CommentRelocationUpdate(
        comment_id=comment.id,
        commit_sha=target_commit_sha,
        file_path=effective_file_path,
        line_number=new_line_number,
        end_line_number=comment.end_line_number + delta,
        status=CommentRelocationStatus.ACTIVE,
        # Not independently re-anchored (see the Comment.paired_line_number
        # doc comment) - shifted by the same delta as the primary range,
        # which is correct as long as the whole adjacent pair moved together.
        paired_line_number=(
            None if comment.paired_line_number is None else comment.paired_line_number + delta
        ),
        paired_end_line_number=(
            None
            if comment.paired_end_line_number is None
            else comment.paired_end_line_number + delta
        ),
    )


def relocate_comments(
    pr_uuid: str,
    repo_path: str | Path,
    old_base: str,
    old_head: str,
    new_base: str,
    new_head: str,
) -> None:
    """Re-anchors a PR's comments after a sync (rebase/amend/force-push)
    changed commit SHAs and/or shifted line content. Called from every place
    that rewrites `pull_requests.head_commit`/`base_commit` in the CLI (the
    `update` command and its two AI-auto-sync call sites in cli.py) with the
    OLD commit range (captured just before the overwrite) and the NEW one.

    No-op sync (nothing actually changed) is skipped entirely - this runs on
    every auto-sync after an AI edit, most of which find no new commits.
    """
    if old_base == new_base and old_head == new_head:
        return

    correspondence = compute_commit_correspondence(
        repo_path, old_base, old_head, new_base, new_head
    )

    for old_sha, new_sha in correspondence["matched"].items():
        if old_sha != new_sha:
            upsert_commit_relocation(pr_uuid, old_sha, new_sha)

    comments = get_comments(pr_uuid)
    if not comments:
        return

    updates = []
    for comment in comments:
        update = _plan_relocation(
            comment, repo_path, correspondence, old_base, old_head, new_base, new_head
        )
        if update:
            updates.append(update)

    apply_comment_relocations(updates)
