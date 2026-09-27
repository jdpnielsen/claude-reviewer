'use client';

import { AlertTriangle, GitPullRequest, Layers } from 'lucide-react';
import Link from 'next/link';

import type { PRData } from '@/app/prs/[id]/types';
import { statusConfig } from '@/app/prs/[id]/utils';
import CopyableText from '@/components/CopyableText';
import StackRail from '@/components/StackRail';
import { treeGuides } from '@/lib/stack-grouping';

type StackEntry = NonNullable<PRData['stack']>[number];

interface StackNavigatorProps {
  stack: StackEntry[];
  currentUuid: string;
}

// The entry `stack[index]` is stacked on: the nearest earlier entry one level
// shallower, since the stack is flattened depth-first.
function parentOf(stack: StackEntry[], index: number): StackEntry | null {
  const { depth } = stack[index];
  for (let i = index - 1; i >= 0; i--) {
    if (stack[i].depth === depth - 1) return stack[i];
  }
  return null;
}

// The Stack tab: every PR in the current one's stack, root first, as a tree
// linking to each. A PR whose parent has moved on since it was cut is flagged
// with the CLI command that restacks it - the web UI doesn't rewrite branches
// itself.
export default function StackNavigator({ stack, currentUuid }: StackNavigatorProps) {
  const guides = treeGuides(stack.map((e) => e.depth));

  return (
    <section aria-label="PR stack">
      <div className="stack-panel-heading">
        <Layers size={16} />
        {stack.length} PRs stacked on <code>{stack[0].base_ref}</code>
      </div>
      <ol className="stack-list">
        {stack.map((entry, index) => {
          const current = entry.uuid === currentUuid;
          const status = statusConfig[entry.status];
          const parent = entry.stale ? parentOf(stack, index) : null;
          return (
            <li
              key={entry.uuid}
              className={`stack-row${current ? ' current' : ''}`}
              style={{ paddingLeft: `calc(1rem + ${entry.depth} * var(--rail-step))` }}
            >
              <StackRail depth={entry.depth} {...guides[index]} />
              <GitPullRequest
                size={16}
                className="stack-row-icon"
                style={{ color: status.color }}
              />
              <div className="stack-row-body">
                <div className="stack-row-title">
                  {current ? (
                    <>
                      <span className="title" aria-current="page">
                        {entry.title}
                      </span>
                      <span className="stack-row-you">This PR</span>
                    </>
                  ) : (
                    <Link href={`/prs/${entry.uuid}/stack`}>{entry.title}</Link>
                  )}
                </div>
                <div className="stack-row-meta">
                  <span>#{entry.uuid}</span>
                  <span>
                    {entry.base_ref} ← {entry.head_ref}
                  </span>
                </div>
                {parent && (
                  <div className="stack-row-stale">
                    <AlertTriangle size={13} />
                    {parent.head_ref} has moved on - restack with
                    <CopyableText
                      text={`claude-reviewer restack ${parent.uuid}`}
                      title="Copy the restack command"
                    >
                      <code>claude-reviewer restack {parent.uuid}</code>
                    </CopyableText>
                  </div>
                )}
              </div>
              <span className="stack-row-status" style={{ color: status.color }}>
                {status.label}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="stack-panel-hint">
        Stacks merge bottom-up. Merging a PR points the ones stacked on it at its base branch.
      </p>
    </section>
  );
}
