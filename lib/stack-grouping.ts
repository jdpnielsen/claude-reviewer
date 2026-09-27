import { PullRequestStatus } from './enum';

// Client-safe (no database or git) stack helpers. A PR is stacked on another
// when its base branch is that PR's head branch, both open and in the same
// repo - the same derivation as the CLI's db.get_stack() and lib/stack.ts.

export interface StackablePR {
  uuid: string;
  repo_path: string;
  base_ref: string;
  head_ref: string;
  status: string;
}

const OPEN_STATUSES: ReadonlySet<string> = new Set([
  PullRequestStatus.Pending,
  PullRequestStatus.Approved,
  PullRequestStatus.ChangesRequested,
]);

export function isOpenStatus(status: string): boolean {
  return OPEN_STATUSES.has(status);
}

export function findParent<T extends StackablePR>(pr: T, openPRs: T[]): T | null {
  return (
    openPRs.find(
      (p) => p.uuid !== pr.uuid && p.repo_path === pr.repo_path && p.head_ref === pr.base_ref,
    ) ?? null
  );
}

export function findChildren<T extends StackablePR>(pr: T, openPRs: T[]): T[] {
  return openPRs.filter(
    (p) => p.uuid !== pr.uuid && p.repo_path === pr.repo_path && p.base_ref === pr.head_ref,
  );
}

// How to draw one row of a depth-first flattened tree (see StackRail).
export interface TreeGuides {
  // guides[l - 1]: whether the line at level l (running down from the
  // level-(l - 1) ancestor) carries on past this row - for l < depth a
  // pass-through line, for l === depth whether this row has a later sibling
  // (├ rather than └).
  guides: boolean[];
  // Whether the next row is this one's child, so a line runs down from it.
  hasChildren: boolean;
}

export function treeGuides(depths: number[]): TreeGuides[] {
  return depths.map((depth, i) => {
    const guides: boolean[] = [];
    for (let level = 1; level <= depth; level++) {
      let continues = false;
      for (let j = i + 1; j < depths.length && depths[j] >= level; j++) {
        if (depths[j] === level) {
          continues = true;
          break;
        }
      }
      guides.push(continues);
    }
    return { guides, hasChildren: depths[i + 1] === depth + 1 };
  });
}

// Order a list so each open PR's children follow it directly, with a depth
// (0 for anything not under another PR in the list) and the guides to draw
// it with. Roots and everything else keep their original relative order.
// Mirrors the CLI's `_order_by_stack`.
export function groupStacks<T extends StackablePR>(
  prs: T[],
): ({ pr: T; depth: number } & TreeGuides)[] {
  const open = prs.filter((p) => isOpenStatus(p.status));
  const hasParent = (p: T) => isOpenStatus(p.status) && findParent(p, open) !== null;

  const ordered: { pr: T; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (pr: T, depth: number) => {
    if (seen.has(pr.uuid)) return;
    seen.add(pr.uuid);
    ordered.push({ pr, depth });
    if (!isOpenStatus(pr.status)) return;
    for (const child of findChildren(pr, open)) visit(child, depth + 1);
  };

  for (const pr of prs) {
    if (!hasParent(pr)) visit(pr, 0);
  }
  // A branch cycle has no root; don't drop its members.
  for (const pr of prs) visit(pr, 0);

  const guides = treeGuides(ordered.map((o) => o.depth));
  return ordered.map((o, i) => ({ ...o, ...guides[i] }));
}
