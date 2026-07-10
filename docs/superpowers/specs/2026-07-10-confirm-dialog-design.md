# Custom confirm dialog (replacing native confirm())

## Context

Two places in the web UI use the native `window.confirm()`:

- `app/prs/[id]/page.tsx:667` — `deleteComment`, message names the reply count when present.
- `app/browse/conversations/page.tsx:202` — `deleteConversation`, static message.

Both call sites are already `async` functions of the shape `if (!confirm(msg)) return;`, so both would return to their normal control flow if `confirm(msg)` becomes `await confirm(msg)`.

Native `confirm()` blocks the page's JS thread until dismissed. This is invisible to a human user but breaks CDP-driven browser automation (Puppeteer, the Claude-in-Chrome extension): any command that depends on the JS thread — including the click that triggered the dialog — hangs until the dialog is resolved out-of-band. The project's own e2e suite (`tests/e2e/pr-workflow.test.ts`) already has two purpose-built workarounds for this (`clickDeleteButtonForComment`'s split click/dialog-promise handling, and `gotoAfterDialog`'s retry for the post-dialog navigation timeout) — this design removes the need for both, by rendering the confirmation as regular DOM content that any DOM-driven automation (or human) can interact with directly.

The project has no existing modal/dialog component and no component library dependency (`lucide-react` is the only UI-adjacent dependency; styling is a single hand-rolled `app/globals.css`, ~1700 lines, GitHub-dark-styled). Introducing a full component library (Primer React, Mantine components) was considered and rejected for this pass — both require their own `ThemeProvider`/design-token system that would compete with, not reuse, the existing hand-rolled theme. That's a much larger, separate decision than "add a confirm dialog," and would warrant its own design if pursued later.

## Decisions made during brainstorming

- **Scope**: replace both native `confirm()` call sites (delete-comment, delete-conversation). Native `alert()` calls (error messaging, several call sites) are out of scope for this pass.
- **Dependency**: add `@mantine/hooks` only (no Mantine components, no theming system) — pure logic hooks, zero styling footprint. Used for `useDisclosure` (open/close state) and `useHotkeys`/`useClickOutside` (Escape and backdrop-click to cancel).
- **Wiring**: a single global `ConfirmProvider`, mounted once in `app/layout.tsx`, exposing a `useConfirm()` hook via React Context — not local per-page state. Trivial to reuse if more confirmations are added later (e.g. merge PR, request AI review).
- **API shape**: mirrors native `confirm()` closely to minimize call-site changes — `confirm(message: string, options?: { danger?: boolean }): Promise<boolean>`.
- **Visual design**: centered card over a semi-transparent backdrop, using the existing theme tokens (`--background`, `--border`, `--foreground`). Confirm button styled like `.delete-btn` (red) when `danger: true`, otherwise `--primary` (blue). Cancel button styled like the existing `.cancel` class.

## Architecture

**New file: `components/ConfirmDialog.tsx`** (client component — `'use client'`, matching the `HeaderNav.tsx` pattern):

- `ConfirmProvider` — wraps `{children}`. Holds pending-confirmation state: `{ message: string; danger?: boolean; resolve: (v: boolean) => void } | null`. Renders the dialog markup when non-null.
- `useConfirm()` — returns the `confirm(message, options?)` function, sourced from Context. Internally, `confirm()` returns `new Promise<boolean>((resolve) => setState({ message, danger, resolve }))`. Clicking Confirm/Cancel/backdrop, or pressing Escape, calls `resolve(true|false)` and clears state.
- Context is created with no default value; `useConfirm()` throws if called outside a `ConfirmProvider` (there is exactly one, in the root layout, so this should never happen in practice — same assumption the codebase already makes elsewhere, e.g. no null-checks on `useContext` results).

**`app/layout.tsx`** — wrap the existing `{children}` (inside `<body>`, alongside the existing `<header>`) with `<ConfirmProvider>`. `layout.tsx` itself stays a server component; only the new provider is a client boundary, same as `HeaderNav` today.

## Behavior

- **Confirm button** click → `resolve(true)`.
- **Cancel button** click, **backdrop** click, or **Escape** key → `resolve(false)`.
- Backdrop click uses `@mantine/hooks`' `useClickOutside` on the dialog card element.
- Escape uses `@mantine/hooks`' `useHotkeys([['Escape', () => resolve(false)]])`, only active while a confirmation is pending.
- No focus trap / focus management beyond what's default — out of scope, matching the rest of this codebase's lack of accessibility-specific handling elsewhere.

## Call site changes

**`app/prs/[id]/page.tsx`** (`deleteComment`, around line 667):
```ts
const confirm = useConfirm();
// ...
const ok = await confirm(message, { danger: true });
if (!ok) return;
```

**`app/browse/conversations/page.tsx`** (`deleteConversation`, around line 202):
```ts
const confirm = useConfirm();
// ...
const ok = await confirm('Are you sure you want to delete this conversation?', { danger: true });
if (!ok) return;
```

Both files already have their delete handlers defined inside the page's client component function body, so `useConfirm()` is called at the top of that component alongside other existing hooks (`useState`, etc.) — no new component boundary needed at the call sites themselves.

## Test impact

`tests/e2e/pr-workflow.test.ts`'s `clickDeleteButtonForComment` and `gotoAfterDialog` helpers exist solely to work around native-dialog CDP blocking. With a DOM-rendered dialog, these are replaced by ordinary element interaction — no more `page.once('dialog', ...)`, no more the first-navigation-after-dialog retry:

```ts
async function clickDeleteButtonForComment(commentText: string) {
  // find the comment element, click its .delete-btn — same as before
  // then click the rendered confirm dialog's Confirm/Cancel button directly
}
```

The three "Comment Deletion" tests (no-replies delete, reply-count + cascade delete, cancel-keeps-comment) keep their assertions, only the interaction mechanics change. `gotoAfterDialog` call sites revert to plain `page.goto()`.

## Edge cases

- **Multiple confirms in flight**: not possible — the provider holds a single pending-confirmation slot, and the UI has no way to trigger a second `confirm()` call before the first resolves (the dialog is modal — the rest of the page is behind the backdrop).
- **Unmount while pending** (e.g. navigating away mid-confirm): the pending Promise never resolves; this matches native `confirm()`'s behavior of blocking navigation anyway (a real navigation can't happen while the dialog — native or custom — is open), so no new failure mode is introduced.

## Testing / verification

1. `npx tsc --noEmit`.
2. `npm run test:e2e` — rewritten "Comment Deletion" tests pass without the dialog-timing workarounds.
3. `npm test` — no unit tests currently cover `deleteConversation`/`deleteComment` UI directly; unaffected.
4. Manual pass in the browser: delete a comment (confirm + cancel paths), delete a conversation (confirm + cancel paths), Escape key cancels, clicking the backdrop cancels.
