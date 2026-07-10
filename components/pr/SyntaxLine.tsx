import { Highlight } from 'prism-react-renderer';

import { githubDarkTheme } from '@/app/prs/[id]/utils';

// Component to render a syntax-highlighted line
export default function SyntaxLine({ code, language }: { code: string; language: string }) {
  return (
    <Highlight theme={githubDarkTheme} code={code} language={language}>
      {({ tokens, getTokenProps }) => (
        <span style={{ whiteSpace: 'pre' }}>
          {tokens[0]?.map((token, i) => (
            <span key={i} {...getTokenProps({ token })} />
          ))}
        </span>
      )}
    </Highlight>
  );
}
