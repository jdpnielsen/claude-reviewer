/**
 * Parsing for GitHub-style suggested-change fences inside comment text.
 *
 * A reviewer can propose exact replacement code for the lines a comment is
 * anchored to by wrapping it in a ```suggestion fenced block, e.g.:
 *
 *   Looks off by one here.
 *
 *   ```suggestion
 *   for (let i = 0; i < items.length - 1; i++) {
 *   ```
 *
 * Read-only: this module only extracts a suggestion for display - applying
 * it to the working tree is left to whoever addresses the comment (a human,
 * or the Claude Code agent reading it via the CLI's own Edit tool).
 */

const SUGGESTION_FENCE = /^```suggestion[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;

export interface ParsedSuggestion {
  prose: string;
  lines: string[];
}

// Extracts the first ```suggestion fenced block from comment content, or
// null if none is present. Only the first fence is recognized - anything
// after it (including another fence) is left as inert prose.
export function parseSuggestion(content: string): ParsedSuggestion | null {
  const match = SUGGESTION_FENCE.exec(content);
  if (match === null) return null;

  const prose = (content.slice(0, match.index) + content.slice(match.index + match[0].length))
    .trim();
  const lines = match[1].split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return { prose, lines };
}

// Appends a ```suggestion fence seeded with the given lines to whatever's
// already in the comment box, so a reviewer only has to edit it down rather
// than retype it. Shared by every place a "Suggest change" button seeds a
// comment textarea (an inline diff range, a commit message, ...).
export function insertSuggestion(currentContent: string, seedLines: string[]): string {
  const fence = '```suggestion\n' + seedLines.join('\n') + '\n```';
  return currentContent.trim() ? `${currentContent}\n\n${fence}` : fence;
}
