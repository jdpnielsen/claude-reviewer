import type { TreeGuides } from '@/lib/stack-grouping';

interface StackRailProps extends TreeGuides {
  depth: number;
}

// The connector lines for one row of a stack tree, drawn absolutely inside a
// `position: relative` row. The row sets where they go through CSS variables:
// --rail-x0 (x of a depth-0 row's icon centre), --rail-step (indent per
// level) and --rail-y (y of the row's icon centre); --rail-icon is the icon
// size. Lines start 1px above the row to bridge the list's 1px row gap.
export default function StackRail({ depth, guides, hasChildren }: StackRailProps) {
  const x = (level: number) => `calc(var(--rail-x0) + ${level} * var(--rail-step))`;

  return (
    <span className="stack-rail" aria-hidden="true">
      {guides
        .slice(0, -1)
        .map((continues, i) =>
          continues ? (
            <span key={i} className="stack-rail-line through" style={{ left: x(i) }} />
          ) : null,
        )}
      {depth > 0 && (
        <>
          <span
            className={`stack-rail-line ${guides[depth - 1] ? 'through' : 'to-elbow'}`}
            style={{ left: x(depth - 1) }}
          />
          <span
            className="stack-rail-elbow"
            style={{
              left: x(depth - 1),
              width: `calc(var(--rail-step) - var(--rail-icon) / 2 - 4px)`,
            }}
          />
        </>
      )}
      {hasChildren && <span className="stack-rail-line from-icon" style={{ left: x(depth) }} />}
    </span>
  );
}
