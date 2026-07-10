# Delete comment (web UI)

## Context

Comments in `app/prs/[id]/page.tsx` already support add, edit, resolve, and reply, but not delete. The API and database layer already have full support for it, unused:

- `deleteComment(commentUuid)` — `lib/database.ts:518-523` — hard `DELETE FROM comments WHERE uuid = ?`. Replies cascade via `comment_replies`' `ON DELETE CASCADE` FK (`PRAGMA foreign_keys = ON` is set, `lib/database.ts:132`).
- `DELETE /api/prs/[id]/comments?uuid=<commentUuid>` — `app/api/prs/[id]/comments/route.ts:130-150` — calls `deleteComment`, returns `{ success: true }` or 404.

Nothing in the web UI calls this endpoint. A sibling feature (`app/browse/conversations/page.tsx`) already has a working delete button (`deleteConversation`, lines 201-213, and its `.delete-btn` JSX, lines 543-552) that this design copies the pattern from.

There is no soft-delete concept anywhere in this codebase (verified: no `is_deleted`/`deleted_at` column exists), and comments have no author/owner field — this is a single-user local tool, so delete is unconditional, matching every other mutation (`resolveComment`, `editComment`) which already have zero permission checks.

Scope for this pass is web UI only. The CLI/Python `database.py` has no `delete_comment` equivalent and no `delete-comment` command — that gap is out of scope here (the CLI already has full comment support otherwise: `comments`, `reply`).

## Decisions made during brainstorming

- **Scope**: web UI button only, no CLI/Python changes.
- **Replies**: the delete button is shown regardless of reply count (unlike the edit button, which hides once a comment has replies — `page.tsx:1259`). Deleting a comment with replies removes both, via the existing FK cascade.
- **Confirmation**: native `confirm()` dialog, matching the `conversations` page's existing convention, with wording that names the reply count when replies exist.
- **State update**: optimistic removal from local state with revert-on-error, matching the existing `editComment`/`resolveComment` pattern exactly (not a full refetch, unlike `conversations`' reload-the-list approach).
- **Styling**: reuse the existing global `.delete-btn` class (`app/globals.css:1531-1539` — transparent background, red border/text, red-tinted hover) rather than adding new CSS. This class is unscoped (not nested under a conversations-page-specific parent selector), so it already applies anywhere the class name is used.

## Frontend (`app/prs/[id]/page.tsx`)

**Button** — add inside the existing `comment-buttons` div (`page.tsx:1258-1273`), after `resolve-btn`:

```jsx
<button className="delete-btn" onClick={() => deleteComment(c.uuid, replies.length)}>
  Delete
</button>
```

**Handler** — new `deleteComment` function, placed near `resolveComment`/`editComment`, following their exact optimistic-update shape:

```ts
const deleteComment = async (commentUuid: string, replyCount: number) => {
  if (!data) return;

  const message = replyCount > 0
    ? `Delete this comment and its ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}?`
    : 'Delete this comment?';
  if (!confirm(message)) return;

  const originalCommentWithReplies = data.comments.find((c) => c.comment.uuid === commentUuid);

  // Optimistically remove from local state
  setData({
    ...data,
    comments: data.comments.filter((c) => c.comment.uuid !== commentUuid),
  });

  try {
    await fetch(`/api/prs/${id}/comments?uuid=${commentUuid}`, { method: 'DELETE' });
  } catch (e) {
    alert('Error deleting comment');
    // Revert on error
    if (originalCommentWithReplies) {
      setData((prev) =>
        prev ? { ...prev, comments: [...prev.comments, originalCommentWithReplies] } : prev
      );
    }
  }
};
```

Naming collision note: the existing import `deleteComment` from `lib/database.ts` is server-only (used inside `app/api/.../route.ts`, not imported into `page.tsx`), so there's no naming conflict with this new client-side function of the same name — consistent with `editComment`/`resolveComment` already shadowing their DB-layer counterparts' concepts by name in this file.

No new state variables needed (unlike `editingComment`/`replyingTo`, delete has no in-place form — it's a single confirm-then-fire action).

## Edge cases

- **Comment being edited or replied to when deleted**: not specially handled — deleting removes the comment from `data.comments`, so if `editingComment.uuid` or `replyingTo` still points at it, the (now-orphaned) edit/reply form simply won't find a matching comment to render next to. This is an existing-class-of-bug already latent in `editComment`/`addReply` (e.g. two browser tabs), not a new one introduced here — out of scope to fix generally in this pass.
- **Double-click / double-delete**: the optimistic removal happens synchronously before the `fetch`, so a second click has no comment left to act on (the button is gone from the DOM). No debounce needed.
- **Sidebar unresolved-comment count**: derived from `data.comments` (per the commit-by-commit design's note at `page.tsx:683`), so it updates automatically when a comment is optimistically removed — no separate update needed.

## Testing / verification

1. `npx tsc --noEmit` (no new types beyond existing `Comment`/`CommentWithReplies` shapes).
2. `npm run build && npm run start`, manual pass against a real PR:
   - Delete a comment with no replies; confirm dialog reads "Delete this comment?"; confirm it disappears and stays gone after a page refresh.
   - Delete a comment with 1 reply; confirm dialog reads "...and its 1 reply?"; confirm both disappear.
   - Delete a comment with 2+ replies; confirm dialog reads "...and its N replies?".
   - Click Delete then cancel the confirm dialog; comment remains untouched.
   - Simulate a failed request (e.g. stop the dev server mid-click, or temporarily throw in the route handler); confirm the comment reappears and an error alert shows.
   - Confirm the unresolved-count sidebar updates correctly after deleting an unresolved comment.
