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
 * A comment can contain more than one fence - each "Insert suggestion" click
 * appends another one rather than replacing the first - so parsing splits
 * the content into an ordered sequence of prose and suggestion segments
 * instead of extracting just one.
 *
 * Read-only: this module only extracts suggestions for display - applying
 * one to the working tree is left to whoever addresses the comment (a
 * human, or the Claude Code agent reading it via the CLI's own Edit tool).
 */

const SUGGESTION_FENCE = /^```suggestion[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

export type CommentSegment =
  | { type: 'prose'; text: string }
  | { type: 'suggestion'; lines: string[] };

// Splits comment content into an ordered sequence of prose and
// ```suggestion fenced-block segments. A comment with no fence at all comes
// back as a single prose segment; empty prose between/around fences (or
// entirely empty content) is omitted rather than represented as an empty
// segment.
export function parseComment(content: string): CommentSegment[] {
  const segments: CommentSegment[] = [];
  let pos = 0;

  for (const match of content.matchAll(SUGGESTION_FENCE)) {
    const prose = content.slice(pos, match.index).trim();
    if (prose) segments.push({ type: 'prose', text: prose });

    const lines = match[1].split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    segments.push({ type: 'suggestion', lines });

    pos = match.index + match[0].length;
  }

  const trailing = content.slice(pos).trim();
  if (trailing) segments.push({ type: 'prose', text: trailing });

  return segments;
}

// Appends a ```suggestion fence seeded with the given lines to whatever's
// already in the comment box, so a reviewer only has to edit it down rather
// than retype it. Shared by every place an "Insert suggestion" button seeds
// a comment textarea (an inline diff range, a commit message, ...) - safe
// to call repeatedly, since each call just appends another fence.
export function insertSuggestion(currentContent: string, seedLines: string[]): string {
  const fence = '```suggestion\n' + seedLines.join('\n') + '\n```';
  return currentContent.trim() ? `${currentContent}\n\n${fence}` : fence;
}
