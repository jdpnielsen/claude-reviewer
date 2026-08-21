import { Highlight } from 'prism-react-renderer';
import type { ReactNode } from 'react';

import { githubDarkTheme } from '@/app/prs/[id]/utils';

// Shared syntax-highlighted code renderer, used both for markdown fenced
// code blocks (via CodeBlock below) and for standalone code display outside
// a markdown document (e.g. a comment's suggested-change block).
export function CodeHighlight({ code, language }: { code: string; language: string }) {
  return (
    <Highlight theme={githubDarkTheme} code={code} language={language || 'plaintext'}>
      {({ style, tokens, getLineProps, getTokenProps }) => (
        <pre
          style={{
            ...style,
            background: '#161b22',
            padding: '16px',
            borderRadius: '6px',
            overflow: 'auto',
          }}
        >
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })}>
              {line.map((token, key) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

// Custom code block renderer for markdown with syntax highlighting
export default function CodeBlock({
  className,
  children,
  ...props
}: {
  className?: string;
  children?: ReactNode;
}) {
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
  const code = String(children).replace(/\n$/, '');

  if (!className) {
    // Inline code
    return (
      <code className="inline-code" {...props}>
        {children}
      </code>
    );
  }

  return <CodeHighlight code={code} language={language} />;
}
