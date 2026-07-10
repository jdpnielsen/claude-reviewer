# Custom confirm dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two native `window.confirm()` calls (delete-comment, delete-conversation) with a custom, DOM-rendered confirm dialog, so no part of the app blocks the page's JS thread with a native dialog.

**Architecture:** A single `ConfirmProvider` (React Context) mounted once in the root layout renders a centered modal card over a backdrop when a confirmation is pending, and exposes a `useConfirm()` hook returning a `(message, options?) => Promise<boolean>` function. Both existing call sites swap `if (!confirm(msg)) return;` for `if (!(await confirm(msg, { danger: true }))) return;`.

**Tech Stack:** Next.js 16 (App Router) + React 19, plain CSS (`app/globals.css`, no CSS-in-JS), `@mantine/hooks` (new dependency, hooks only — no `@mantine/core`, no theming system).

## Global Constraints

- No new dependency beyond `@mantine/hooks` (peer dep `react ^19.2.0`; project is on `react@19.2.3` — satisfied). Do not add `@mantine/core` or any other component library.
- Reuse existing CSS custom properties (`--background`, `--foreground`, `--border`, `--primary`, `--primary-hover`) rather than hardcoding new colors, except where matching the existing `.delete-btn` red (`#f85149`) which is itself hardcoded in `globals.css` today.
- `.cancel` (`app/globals.css:950`) is a compound selector scoped to `.comment-actions button.cancel` — it does **not** apply if reused as a bare `className="cancel"` elsewhere. The dialog's buttons get their own dedicated classes (`.confirm-dialog-cancel-btn`, `.confirm-dialog-confirm-btn`, `.confirm-dialog-confirm-btn-danger`) rather than attempting to reuse it.
- Every task that touches a `.ts`/`.tsx` file ends with `npx tsc --noEmit` passing.

---

### Task 1: Confirm dialog component, tests, and wiring

**Files:**
- Create: `components/ConfirmDialog.tsx`
- Create: `__tests__/ConfirmDialog.test.tsx`
- Modify: `app/globals.css:1549` (insert new rules after the `.view-file-btn:hover` block, before the `/* Claude respond buttons */` comment)
- Modify: `app/layout.tsx`
- Modify: `package.json` / `package-lock.json` (via `npm install`)

**Interfaces:**
- Produces: `ConfirmProvider` (component, `{ children: ReactNode }` prop) and `useConfirm(): (message: string, options?: { danger?: boolean }) => Promise<boolean>`, both exported from `@/components/ConfirmDialog`. Tasks 2 and 3 consume `useConfirm` by this exact name and signature.

- [ ] **Step 1: Install `@mantine/hooks`**

Run: `npm install @mantine/hooks`
Expected: `package.json` gains `"@mantine/hooks": "^9.4.1"` (or whatever the installed semver range resolves to) under `dependencies`.

- [ ] **Step 2: Write the failing component test**

Create `__tests__/ConfirmDialog.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmProvider, useConfirm } from '@/components/ConfirmDialog';

function TestHarness() {
  const confirm = useConfirm();
  const [result, setResult] = useState('none');

  const handleClick = async () => {
    const ok = await confirm('Delete this thing?', { danger: true });
    setResult(ok ? 'confirmed' : 'cancelled');
  };

  return (
    <div>
      <button onClick={handleClick}>Trigger</button>
      <div data-testid="result">{result}</div>
    </div>
  );
}

function renderHarness() {
  return render(
    <ConfirmProvider>
      <TestHarness />
    </ConfirmProvider>
  );
}

describe('ConfirmDialog', () => {
  test('renders nothing when no confirmation is pending', () => {
    renderHarness();
    expect(screen.queryByText('Delete this thing?')).not.toBeInTheDocument();
  });

  test('shows the message and resolves true when Confirm is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));
    expect(await screen.findByText('Delete this thing?')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Confirm'));
    expect(await screen.findByTestId('result')).toHaveTextContent('confirmed');
  });

  test('resolves false when Cancel is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));
    await screen.findByText('Delete this thing?');

    fireEvent.click(screen.getByText('Cancel'));
    expect(await screen.findByTestId('result')).toHaveTextContent('cancelled');
  });

  test('resolves false when Escape is pressed', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));
    await screen.findByText('Delete this thing?');

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(await screen.findByTestId('result')).toHaveTextContent('cancelled');
  });

  test('resolves false when the backdrop is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));
    await screen.findByText('Delete this thing?');

    fireEvent.mouseDown(screen.getByTestId('confirm-backdrop'));
    expect(await screen.findByTestId('result')).toHaveTextContent('cancelled');
  });

  test('applies the danger class to the confirm button when danger: true', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));

    const confirmBtn = await screen.findByText('Confirm');
    expect(confirmBtn).toHaveClass('confirm-dialog-confirm-btn-danger');
  });
});
```

- [ ] **Step 2b: Run the test to verify it fails**

Run: `npm test -- ConfirmDialog`
Expected: FAIL — `Cannot find module '@/components/ConfirmDialog'`.

- [ ] **Step 3: Implement the component**

Create `components/ConfirmDialog.tsx`:

```tsx
'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useClickOutside, useHotkeys } from '@mantine/hooks';

interface ConfirmOptions {
  danger?: boolean;
}

type ConfirmFn = (message: string, options?: ConfirmOptions) => Promise<boolean>;

interface PendingConfirm {
  message: string;
  danger: boolean;
  resolve: (value: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((message, options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ message, danger: options?.danger ?? false, resolve });
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const cardRef = useClickOutside(() => settle(false));

  useHotkeys([['Escape', () => settle(false)]]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="confirm-dialog-backdrop" data-testid="confirm-backdrop">
          <div className="confirm-dialog-card" ref={cardRef}>
            <p className="confirm-dialog-message">{pending.message}</p>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-cancel-btn" onClick={() => settle(false)}>
                Cancel
              </button>
              <button
                className={`confirm-dialog-confirm-btn${pending.danger ? ' confirm-dialog-confirm-btn-danger' : ''}`}
                onClick={() => settle(true)}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return ctx;
}
```

Note on `pending !== null` vs. `useDisclosure`: the brainstorm discussed using `@mantine/hooks`' `useDisclosure` to track open/closed state. `pending`'s presence already *is* that boolean (`pending !== null` ⇔ open) — adding `useDisclosure` on top would mean two pieces of state that must be kept in sync on every open/close, for no behavioral gain. `useClickOutside` and `useHotkeys` are the two hooks doing real work (wrapping non-trivial `document`-level event listener logic) and are the ones actually used here.

- [ ] **Step 4: Add the CSS**

In `app/globals.css`, insert after line 1549 (the blank line right before `/* Claude respond buttons */`):

```css
/* Confirm dialog */
.confirm-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(1, 4, 9, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.confirm-dialog-card {
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.5rem;
  max-width: 400px;
  width: 90%;
  box-shadow: 0 8px 24px rgba(1, 4, 9, 0.5);
}

.confirm-dialog-message {
  margin: 0 0 1.25rem;
  color: var(--foreground);
  font-size: 0.95rem;
}

.confirm-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.confirm-dialog-cancel-btn,
.confirm-dialog-confirm-btn {
  padding: 0.375rem 0.9rem;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}

.confirm-dialog-cancel-btn {
  background: #21262d;
  color: #8b949e;
  border: 1px solid var(--border);
}

.confirm-dialog-confirm-btn {
  background: var(--primary);
  color: #ffffff;
  border: 1px solid var(--primary);
}

.confirm-dialog-confirm-btn:hover {
  background: var(--primary-hover);
}

.confirm-dialog-confirm-btn-danger {
  background: transparent;
  color: #f85149;
  border: 1px solid #f85149;
}

.confirm-dialog-confirm-btn-danger:hover {
  background: rgba(248, 81, 73, 0.1);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- ConfirmDialog`
Expected: PASS, 6 tests.

- [ ] **Step 6: Wire `ConfirmProvider` into the root layout**

In `app/layout.tsx`, add the import:

```tsx
import { ConfirmProvider } from '@/components/ConfirmDialog';
```

Wrap the existing `<header>` and `{children}` in `<ConfirmProvider>`:

```tsx
      <body>
        <ConfirmProvider>
          <header>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
              <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 600, fontSize: '1.25rem', textDecoration: 'none', color: 'inherit' }}>
                <GitPullRequest size={24} />
                Claude Reviewer
              </Link>
              <HeaderNav />
            </div>
            <div style={{ fontSize: '0.9rem', color: '#8b949e' }}>
              Local Code Review System
            </div>
          </header>
          {children}
        </ConfirmProvider>
      </body>
```

- [ ] **Step 7: Verify types and full unit suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: all suites pass, including the new `ConfirmDialog` suite.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json components/ConfirmDialog.tsx __tests__/ConfirmDialog.test.tsx app/globals.css app/layout.tsx
git commit -m "feat: add reusable confirm dialog component"
```

---

### Task 2: Use the confirm dialog for comment deletion

**Files:**
- Modify: `app/prs/[id]/page.tsx`

**Interfaces:**
- Consumes: `useConfirm()` from `@/components/ConfirmDialog` (Task 1).

- [ ] **Step 1: Import the hook**

In `app/prs/[id]/page.tsx`, add after the existing `remark-gfm` import (line 7):

```ts
import { useConfirm } from '@/components/ConfirmDialog';
```

- [ ] **Step 2: Call the hook in the component**

In `PRPage` (starting line 214), add right after `const { id } = use(params);`:

```ts
  const confirm = useConfirm();
```

- [ ] **Step 3: Replace the native call in `deleteComment`**

Change (currently line 667):

```ts
    if (!confirm(message)) return;
```

to:

```ts
    if (!(await confirm(message, { danger: true }))) return;
```

- [ ] **Step 4: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "app/prs/[id]/page.tsx"
git commit -m "feat: use custom confirm dialog for comment deletion"
```

---

### Task 3: Use the confirm dialog for conversation deletion

**Files:**
- Modify: `app/browse/conversations/page.tsx`

**Interfaces:**
- Consumes: `useConfirm()` from `@/components/ConfirmDialog` (Task 1).

- [ ] **Step 1: Import the hook**

In `app/browse/conversations/page.tsx`, add after the existing `Link` import (line 4):

```ts
import { useConfirm } from '@/components/ConfirmDialog';
```

- [ ] **Step 2: Call the hook in the component**

In `ConversationsListPage` (starting line 70), add right after `const [claudeError, setClaudeError] = useState<string | null>(null);`:

```ts
  const confirm = useConfirm();
```

- [ ] **Step 3: Replace the native call in `deleteConversation`**

Change (currently line 202):

```ts
    if (!confirm('Are you sure you want to delete this conversation?')) return;
```

to:

```ts
    if (!(await confirm('Are you sure you want to delete this conversation?', { danger: true }))) return;
```

- [ ] **Step 4: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/browse/conversations/page.tsx
git commit -m "feat: use custom confirm dialog for conversation deletion"
```

---

### Task 4: Simplify the e2e Comment Deletion tests

**Files:**
- Modify: `tests/e2e/pr-workflow.test.ts:199-307` (the `describe("Comment Deletion", ...)` block)

**Interfaces:**
- Consumes: the `.confirm-dialog-backdrop` / `.confirm-dialog-message` / `.confirm-dialog-cancel-btn` / `.confirm-dialog-confirm-btn` classes rendered by `ConfirmProvider` (Task 1).

- [ ] **Step 1: Replace the `describe("Comment Deletion", ...)` block**

Replace lines 199-307 with:

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
      await deleteBtn.click();
      await page.waitForSelector(".confirm-dialog-backdrop", { timeout: 5000 });
    }

    async function confirmDialogMessage(): Promise<string> {
      return page.$eval(".confirm-dialog-message", (el) => el.textContent ?? "");
    }

    async function acceptConfirmDialog() {
      await page.click(".confirm-dialog-confirm-btn");
      await page.waitForSelector(".confirm-dialog-backdrop", { hidden: true, timeout: 5000 });
    }

    async function cancelConfirmDialog() {
      await page.click(".confirm-dialog-cancel-btn");
      await page.waitForSelector(".confirm-dialog-backdrop", { hidden: true, timeout: 5000 });
    }

    test("shows a confirm dialog and removes a comment with no replies", async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.body.textContent?.includes("Please add documentation for this constant"),
        { timeout: 20000 }
      );

      await clickDeleteButtonForComment("Please add documentation for this constant");
      expect(await confirmDialogMessage()).toBe("Delete this comment?");
      await acceptConfirmDialog();

      await page.waitForFunction(
        () => !document.body.textContent?.includes("Please add documentation for this constant"),
        { timeout: 10000 }
      );

      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`, { waitUntil: 'domcontentloaded' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const content = await page.content();
      expect(content).not.toContain("Please add documentation for this constant");
    });

    test("mentions the reply count and removes both comment and reply", async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.body.textContent?.includes("This needs a reply-count test"),
        { timeout: 20000 }
      );

      await clickDeleteButtonForComment("This needs a reply-count test");
      expect(await confirmDialogMessage()).toBe("Delete this comment and its 1 reply?");
      await acceptConfirmDialog();

      await page.waitForFunction(
        () => !document.body.textContent?.includes("This needs a reply-count test"),
        { timeout: 10000 }
      );

      const content = await page.content();
      expect(content).not.toContain("Good catch");
    });

    test("keeps the comment when the confirm dialog is cancelled", async () => {
      addComment(testPRUuid, "test.ts", 4, "Do not delete me");
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.body.textContent?.includes("Do not delete me"),
        { timeout: 20000 }
      );

      await clickDeleteButtonForComment("Do not delete me");
      await cancelConfirmDialog();

      await new Promise((resolve) => setTimeout(resolve, 500));
      const content = await page.content();
      expect(content).toContain("Do not delete me");
    });
  });
```

This drops the per-test `60000` timeout override, the `dialog`/`clickPromise` split-promise dance, and the `gotoAfterDialog` retry helper entirely — none are needed once the dialog is regular DOM content instead of a native, thread-blocking one.

- [ ] **Step 2: Run the e2e suite**

Run: `npm run test:e2e`
Expected: all tests pass (14/14), including the three rewritten "Comment Deletion" tests, with no timeout-related retries needed.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/pr-workflow.test.ts
git commit -m "test: simplify e2e comment-deletion tests for the DOM-based confirm dialog"
```

---

After all tasks are complete, use **superpowers:finishing-a-development-branch** to verify the full test suite (`npm test`, `npm run test:e2e`, `npx tsc --noEmit`) and decide how to integrate the branch.

Note: `app/browse/conversations/page.tsx` has no e2e coverage today (only `tests/e2e/pr-workflow.test.ts` and `diff-viewer.test.ts` exist, neither touches the conversations page), so Task 3's change is verified by the Task 1 component test plus `tsc`. Before finishing, manually click through delete-conversation's confirm and cancel paths in the browser once, matching the existing depth of testing for that page.
