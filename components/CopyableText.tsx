'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

interface CopyableTextProps {
  // What lands on the clipboard - can differ from what's shown, e.g. a full
  // SHA behind its short form.
  text: string;
  children: React.ReactNode;
  className?: string;
  title?: string;
}

const COPIED_FEEDBACK_MS = 1500;

// Inline text that copies `text` when clicked. A copy icon appears on hover
// so the affordance doesn't clutter the line until it's wanted, and swaps to
// a check briefly once the copy has gone through.
export default function CopyableText({ text, children, className, title }: CopyableTextProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    // Rejects outside a secure context or without clipboard permission -
    // nothing useful to show then, so just skip the "copied" feedback.
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => {},
    );
  };

  return (
    <button
      type="button"
      className={`copyable-text ${copied ? 'copied' : ''} ${className ?? ''}`}
      onClick={copy}
      title={title ?? `Copy ${text}`}
    >
      {children}
      {copied ? (
        <Check size={12} className="copyable-text-icon" aria-label="Copied" />
      ) : (
        <Copy size={12} className="copyable-text-icon" aria-hidden />
      )}
    </button>
  );
}
