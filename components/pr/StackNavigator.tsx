'use client';

import { AlertTriangle, Layers } from 'lucide-react';
import Link from 'next/link';

import type { PRData } from '@/app/prs/[id]/types';
import { statusConfig } from '@/app/prs/[id]/utils';
import CopyableText from '@/components/CopyableText';

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

// The stack of PRs the current one belongs to, root first, each linking to
// its PR. A PR whose parent has moved on since it was cut is flagged with the
// CLI command that restacks it - the web UI doesn't rewrite branches itself.
export default function StackNavigator({ stack, currentUuid }: StackNavigatorProps) {
  const root = stack[0];

  return (
    <nav className="stack-nav" aria-label="PR stack">
      <div className="stack-nav-heading">
        <Layers size={14} />
        Stack on <code>{root.base_ref}</code>
      </div>
      <ol className="stack-nav-list">
        {stack.map((entry, index) => {
          const current = entry.uuid === currentUuid;
          const status = statusConfig[entry.status];
          const parent = entry.stale ? parentOf(stack, index) : null;
          return (
            <li
              key={entry.uuid}
              className={`stack-nav-entry${current ? ' current' : ''}`}
              style={{ paddingLeft: `${entry.depth * 1.25}rem` }}
            >
              <div className="stack-nav-row">
                {entry.depth > 0 && <span className="stack-nav-branch">└─</span>}
                {current ? (
                  <span className="stack-nav-title" aria-current="page">
                    {entry.title}
                  </span>
                ) : (
                  <Link href={`/prs/${entry.uuid}`} className="stack-nav-title">
                    {entry.title}
                  </Link>
                )}
                <code className="stack-nav-ref">{entry.head_ref}</code>
                <span className="stack-nav-status" style={{ color: status.color }}>
                  {status.label}
                </span>
              </div>
              {parent && (
                <div className="stack-nav-stale">
                  <AlertTriangle size={12} />
                  Needs restack onto <code>{parent.head_ref}</code> -{' '}
                  <CopyableText
                    text={`claude-reviewer restack ${parent.uuid}`}
                    title="Copy the restack command"
                  >
                    <code>claude-reviewer restack {parent.uuid}</code>
                  </CopyableText>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
