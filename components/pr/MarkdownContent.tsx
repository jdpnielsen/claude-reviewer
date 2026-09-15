import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import CodeBlock from './CodeBlock';

// Shared markdown renderer for any author-written prose we display: markdown
// file previews in the diff and the PR description. Keeping one component means
// fenced code blocks get syntax highlighting everywhere, not just in previews.
export default function MarkdownContent({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={className ? `markdown-body ${className}` : 'markdown-body'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
