'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import MarkdownContent from './MarkdownContent';

// A PR's description sits between its title and the diff, so a long one pushes
// the actual review off the screen. Collapsed it shows the opening couple of
// lines - enough for the summary most descriptions lead with - behind a toggle
// for the rest. The clamp height itself lives in CSS (.pr-description-clamped);
// nothing here needs to know how many lines it works out to.
export default function CollapsibleDescription({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Only offer the toggle when the clamp is actually hiding something, so a
  // one-line description doesn't get a "Show more" that reveals nothing.
  // Measured only while collapsed: expanding drops the clamp, so clientHeight
  // would then report the full height and every description would read as
  // fitting. Staying on the last collapsed measurement is fine, because the
  // only button it can produce while expanded is "Show less" - always a valid
  // thing to offer. A ResizeObserver rather than a window resize listener
  // because the column can also change width on its own (the sidebar), and a
  // narrower column wraps the same text onto more lines.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    // The +1 absorbs sub-pixel rounding between the clamp and the line box.
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, description]);

  // The clamp has to stay on even when nothing overflows: dropping it would
  // make clientHeight report the full height, flipping `overflows` back to
  // false and oscillating. Only the fade is conditional.
  const clampClass = overflows ? 'pr-description-clamped is-truncated' : 'pr-description-clamped';

  return (
    <div className="pr-description">
      <MarkdownContent ref={bodyRef} className={expanded ? undefined : clampClass}>
        {description}
      </MarkdownContent>
      {overflows && (
        <button
          type="button"
          className="pr-description-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
