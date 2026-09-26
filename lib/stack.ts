import { listOpenPRs, type PullRequest } from './database';
import { isAncestor } from './git';
import { findChildren, findParent, isOpenStatus } from './stack-grouping';

// Server-side stack derivation - see lib/stack-grouping.ts for the rule.

export interface StackEntry {
  uuid: string;
  title: string;
  status: PullRequest['status'];
  head_ref: string;
  base_ref: string;
  depth: number;
  // Whether this PR's parent has moved on since it was cut (the parent's tip
  // isn't an ancestor of this PR's head) - `claude-reviewer restack` fixes it.
  // Always false for the root.
  stale: boolean;
}

export function getParent(pr: PullRequest): PullRequest | null {
  if (!isOpenStatus(pr.status)) return null;
  return findParent(pr, listOpenPRs(pr.repo_path));
}

export function getChildren(pr: PullRequest): PullRequest[] {
  if (!isOpenStatus(pr.status)) return [];
  return findChildren(pr, listOpenPRs(pr.repo_path));
}

export function isStale(repoPath: string, parentRef: string, childRef: string): boolean {
  return !isAncestor(repoPath, parentRef, childRef);
}

// The whole stack `pr` belongs to, flattened depth-first from its root, or
// null when it isn't stacked (a closed/merged PR never is). `checkStale`
// runs git per entry, so pass false when the repo may be unavailable.
export function getStack(pr: PullRequest, checkStale = true): StackEntry[] | null {
  if (!isOpenStatus(pr.status)) return null;
  const open = listOpenPRs(pr.repo_path);

  let root = pr;
  const climbed = new Set([root.uuid]);
  for (let parent = findParent(root, open); parent; parent = findParent(root, open)) {
    if (climbed.has(parent.uuid)) break;
    climbed.add(parent.uuid);
    root = parent;
  }

  const entries: StackEntry[] = [];
  const visited = new Set<string>();
  const visit = (node: PullRequest, parent: PullRequest | null, depth: number) => {
    if (visited.has(node.uuid)) return;
    visited.add(node.uuid);
    entries.push({
      uuid: node.uuid,
      title: node.title,
      status: node.status,
      head_ref: node.head_ref,
      base_ref: node.base_ref,
      depth,
      stale: checkStale && parent !== null && isStale(pr.repo_path, parent.head_ref, node.head_ref),
    });
    for (const child of findChildren(node, open)) visit(child, node, depth + 1);
  };
  visit(root, null, 0);

  return entries.length > 1 ? entries : null;
}
