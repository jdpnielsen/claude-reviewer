# Delete Comment (Web UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Delete button to inline PR comments in the web UI, wired to the already-working `DELETE /api/prs/[id]/comments` endpoint.

**Architecture:** `app/prs/[id]/page.tsx` gets one new client-side handler (`deleteComment`) and one new button, following the exact optimistic-update pattern already used by `resolveComment`/`editComment` in the same file. No API, database, or CSS changes — `deleteComment` (`lib/database.ts:518-523`) and `DELETE /api/prs/[id]/comments?uuid=` (`app/api/prs/[id]/comments/route.ts:130-150`) already exist and work, and the `.delete-btn` class (`app/globals.css:1531-1539`) is already global and unstyled-for-reuse.

**Tech Stack:** Next.js (App Router) client component (`'use client'`), TypeScript, Jest + Puppeteer for e2e tests (`test-config/jest.e2e.config.ts`, `tests/e2e/*.test.ts`).

**Design spec:** `docs/superpowers/specs/2026-07-10-delete-comment-design.md`

## Global Constraints

- Web UI only — no CLI or Python `database.py` changes (out of scope; see spec's Context section).
- Delete is unconditional regardless of reply count — no permission/ownership checks (this is a single-user local tool; comments have no author field).
- Deleting a comment with replies cascades to its replies via the existing `comment_replies` FK (`ON DELETE CASCADE`) — no explicit reply-deletion code needed.
- Reuse the existing global `.delete-btn` CSS class — do not add new CSS.
- State updates must follow the existing optimistic-update-then-revert-on-error pattern (`resolveComment`/`editComment`, `app/prs/[id]/page.tsx:520-556, 628-658`), not a full refetch.

---

### Task 1: Delete comment button + handler

**Files:**
- Modify: `app/prs/[id]/page.tsx` (add `deleteComment` handler near `resolveComment`; add a `delete-btn` button inside the `comment-buttons` div)
- Modify: `tests/e2e/pr-workflow.test.ts` (add `addReply` import, seed a second comment+reply in `beforeAll`, add a `Comment Deletion` describe block)

**Interfaces:**
- Consumes: `DELETE /api/prs/[id]/comments?uuid=<commentUuid>` (existing, `app/api/prs/[id]/comments/route.ts:130-150`, returns `{ success: true }` or 404 — response status is not checked, matching how `resolveComment`/`editComment` already ignore it). Consumes existing `data: { comments: CommentWithReplies[] } | null` and `setData` component state, and existing `id` (PR uuid) from the page's props/params, all already in scope in `page.tsx`.
- Produces: nothing — this is the only task in this plan.

- [ ] **Step 1: Write the failing e2e tests**

Open `tests/e2e/pr-workflow.test.ts`. Add `addReply` to the existing database import, and add a new `describe("Comment Deletion", ...)` block as a sibling of the existing `describe("PR Review Page", ...)` block (same nesting level, inside the outer `describe("PR Workflow E2E Tests", ...)`).

Change the import at the top of the file from:

```ts
import {
  createPR,
  addComment,
  closeDatabase,
} from "../../lib/database";
```

to:

```ts
import {
  createPR,
  addComment,
  addReply,
  closeDatabase,
} from "../../lib/database";
```

Add this new `describe` block directly after the closing `});` of `describe("PR Review Page", ...)` (i.e. before `describe("Navigation", ...)`):

```ts
  describe("Comment Deletion", () => {
    let replyCommentUuid: string;

    beforeAll(() => {
      replyCommentUuid = addComment(testPRUuid, "test.ts", 3, "This needs a reply-count test");
      addReply(replyCommentUuid, "Good catch");
    });

    async function clickDeleteButtonForComment(commentText: string) {
      const handle = await page.evaluateHandle((text) => {
        const comments = Array.from(document.querySelectorAll(".inline-comment"));
        return comments.find((el) => el.textContent?.includes(text)) ?? null;
      }, commentText);
      const el = handle.asElement();
      if (!el) throw new Error(`Comment containing "${commentText}" not found`);
      const deleteBtn = await el.$(".delete-btn");
      if (!deleteBtn) throw new Error("Delete button not found");

      const [dialog] = await Promise.all([
        new Promise<import("puppeteer").Dialog>((resolve) => page.once("dialog", resolve)),
        deleteBtn.click(),
      ]);
      return dialog;
    }

    test("shows a confirm dialog and removes a comment with no replies", async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForFunction(
        () => document.body.textContent?.includes("Please add documentation for this constant"),
        { timeout: 10000 }
      );

      const dialog = await clickDeleteButtonForComment("Please add documentation for this constant");
      expect(dialog.message()).toBe("Delete this comment?");
      await dialog.accept();

      await page.waitForFunction(
        () => !document.body.textContent?.includes("Please add documentation for this constant"),
        { timeout: 10000 }
      );

      await page.reload();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const content = await page.content();
      expect(content).not.toContain("Please add documentation for this constant");
    });

    test("mentions the reply count and removes both comment and reply", async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForFunction(
        () => document.body.textContent?.includes("This needs a reply-count test"),
        { timeout: 10000 }
      );

      const dialog = await clickDeleteButtonForComment("This needs a reply-count test");
      expect(dialog.message()).toBe("Delete this comment and its 1 reply?");
      await dialog.accept();

      await page.waitForFunction(
        () => !document.body.textContent?.includes("This needs a reply-count test"),
        { timeout: 10000 }
      );

      const content = await page.content();
      expect(content).not.toContain("Good catch");
    });

    test("keeps the comment when the confirm dialog is cancelled", async () => {
      addComment(testPRUuid, "test.ts", 4, "Do not delete me");
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForFunction(
        () => document.body.textContent?.includes("Do not delete me"),
        { timeout: 10000 }
      );

      const dialog = await clickDeleteButtonForComment("Do not delete me");
      await dialog.dismiss();

      await new Promise((resolve) => setTimeout(resolve, 500));
      const content = await page.content();
      expect(content).toContain("Do not delete me");
    });
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx jest --config test-config/jest.e2e.config.ts tests/e2e/pr-workflow.test.ts -t "Comment Deletion"`

Expected: FAIL — all three tests time out or throw `Delete button not found` (no `.delete-btn` exists yet in `page.tsx`), or the first `waitForFunction`/dialog promise never resolves because no dialog is ever shown.

- [ ] **Step 3: Implement the delete button and handler**

In `app/prs/[id]/page.tsx`, add the `deleteComment` function immediately after the existing `resolveComment` function (`page.tsx:628-658`):

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

Then in the JSX, modify the `comment-buttons` div (`page.tsx:1258-1273`) to add the delete button after the resolve button:

```jsx
                                    <div className="comment-buttons">
                                      {replies.length === 0 && (
                                        <button
                                          className="edit-btn"
                                          onClick={() => setEditingComment({ uuid: c.uuid, content: c.content })}
                                        >
                                          Edit
                                        </button>
                                      )}
                                      <button
                                        className="resolve-btn"
                                        onClick={() => resolveComment(c.uuid, !c.resolved)}
                                      >
                                        {c.resolved ? 'Unresolve' : 'Resolve'}
                                      </button>
                                      <button
                                        className="delete-btn"
                                        onClick={() => deleteComment(c.uuid, replies.length)}
                                      >
                                        Delete
                                      </button>
                                    </div>
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `npx jest --config test-config/jest.e2e.config.ts tests/e2e/pr-workflow.test.ts`

Expected: PASS — all tests in the file pass, including the new `Comment Deletion` block and every pre-existing test (confirms nothing else broke).

Also run the full e2e suite and the type checker to catch cross-file regressions:

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run test:e2e`
Expected: PASS — both `pr-workflow.test.ts` and `diff-viewer.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add app/prs/[id]/page.tsx tests/e2e/pr-workflow.test.ts
git commit -m "feat: add delete comment button to PR review page"
```

## Self-Review Notes

- **Spec coverage**: button placement/styling (spec's Frontend section) → Step 3 JSX change. `deleteComment` handler shape (optimistic update, revert-on-error, confirm wording) → Step 3 function, matches spec's code block verbatim. Reply-count wording edge cases (0, 1, N replies) → covered by the three e2e tests in Step 1. Cascade-delete-with-replies → covered by the second test asserting the reply text (`"Good catch"`) is also gone. No CSS task needed — spec confirms `.delete-btn` already exists globally.
- **Placeholder scan**: no TBD/TODO; all code blocks are complete and copy-pasteable.
- **Type consistency**: `deleteComment(commentUuid: string, replyCount: number)` is called consistently in the JSX (`deleteComment(c.uuid, replies.length)`) and defined with matching parameter names/order. Test helper `clickDeleteButtonForComment` returns a `Dialog` consumed consistently across all three tests (`.message()`, `.accept()`, `.dismiss()`).
