'use client';

import { ChevronDown, ChevronRight, Code, Eye, MoreHorizontal, Plus } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import CodeBlock from './CodeBlock';
import CommentThread from './CommentThread';
import NewCommentForm from './NewCommentForm';
import SyntaxLine from './SyntaxLine';
import type {
  CommentingAt,
  CommentWithReplies,
  EditingComment,
  FileInfo,
  LastClickedLine,
} from '@/app/prs/[id]/types';
import {
  getFileContentFromDiff,
  getLanguage,
  isMarkdownFile,
  MAX_LINES_DEFAULT,
  parseFileDiff,
} from '@/app/prs/[id]/utils';
import { LineType } from '@/lib/enum';

interface FileDiffCardProps {
  file: FileInfo;
  diff: string;
  fileComments: CommentWithReplies[];
  isExpanded: boolean;
  toggleFile: (path: string) => void;
  isPreview: boolean;
  togglePreview: (path: string) => void;
  showAllLines: Set<string>;
  setShowAllLines: Dispatch<SetStateAction<Set<string>>>;
  expandedContext: Map<string, string[]>;
  loadingContext: Set<string>;
  fetchContext: (filePath: string, startLine: number, endLine: number, key: string) => void;
  commentingAt: CommentingAt | null;
  setCommentingAt: Dispatch<SetStateAction<CommentingAt | null>>;
  lastClickedLine: LastClickedLine | null;
  setLastClickedLine: Dispatch<SetStateAction<LastClickedLine | null>>;
  newComment: string;
  setNewComment: Dispatch<SetStateAction<string>>;
  addComment: () => void;
  editingComment: EditingComment | null;
  setEditingComment: Dispatch<SetStateAction<EditingComment | null>>;
  editComment: () => void;
  replyingTo: string | null;
  setReplyingTo: Dispatch<SetStateAction<string | null>>;
  replyContent: string;
  setReplyContent: Dispatch<SetStateAction<string>>;
  addReply: (commentUuid: string) => void;
  resolveComment: (commentUuid: string, resolved: boolean) => void;
  deleteComment: (commentUuid: string, replyCount: number) => void;
}

export default function FileDiffCard({
  file,
  diff,
  fileComments,
  isExpanded,
  toggleFile,
  isPreview,
  togglePreview,
  showAllLines,
  setShowAllLines,
  expandedContext,
  loadingContext,
  fetchContext,
  commentingAt,
  setCommentingAt,
  lastClickedLine,
  setLastClickedLine,
  newComment,
  setNewComment,
  addComment,
  editingComment,
  setEditingComment,
  editComment,
  replyingTo,
  setReplyingTo,
  replyContent,
  setReplyContent,
  addReply,
  resolveComment,
  deleteComment,
}: FileDiffCardProps) {
  const diffLines = parseFileDiff(diff, file.path);
  const isMd = isMarkdownFile(file.path);

  return (
    <div id={`file-${file.path.replace(/[^a-zA-Z0-9]/g, '-')}`} className="file-diff">
      <div className="file-header">
        <div
          className="file-header-left"
          role="button"
          tabIndex={0}
          onClick={() => toggleFile(file.path)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleFile(file.path);
            }
          }}
        >
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="file-path">{file.path}</span>
          <span className="file-badge">{file.changeType}</span>
        </div>
        {isMd && isExpanded && (
          <button
            className={`preview-toggle ${isPreview ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              togglePreview(file.path);
            }}
          >
            {isPreview ? <Code size={14} /> : <Eye size={14} />}
            {isPreview ? 'Raw' : 'Preview'}
          </button>
        )}
      </div>

      {isExpanded && isPreview && isMd && (
        <div className="markdown-preview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: CodeBlock,
            }}
          >
            {getFileContentFromDiff(diff, file.path)}
          </ReactMarkdown>
        </div>
      )}

      {isExpanded && !isPreview && (
        <div className="diff-content">
          {(() => {
            let oldLineNum = 0;
            let newLineNum = 0;
            let hunkIndex = -1;
            let hunkStartLine = 0;

            // Pre-process to find hunk boundaries
            const hunkStarts: number[] = [];
            diffLines.forEach((line, idx) => {
              if (line.startsWith('@@')) {
                hunkStarts.push(idx);
              }
            });

            // Limit lines for large diffs unless "show all" is enabled
            const isLargeDiff = diffLines.length > MAX_LINES_DEFAULT;
            const shouldLimit = isLargeDiff && !showAllLines.has(file.path);
            const linesToRender = shouldLimit ? diffLines.slice(0, MAX_LINES_DEFAULT) : diffLines;

            return (
              <>
                {linesToRender.map((line, idx) => {
                  // Parse hunk header for line numbers
                  if (line.startsWith('@@')) {
                    hunkIndex++;
                    const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
                    if (match) {
                      oldLineNum = parseInt(match[1]) - 1;
                      newLineNum = parseInt(match[2]) - 1;
                      hunkStartLine = newLineNum + 1;
                    }
                  }

                  // Track line numbers based on line type
                  let displayOldLine = '';
                  let displayNewLine = '';
                  let indicator = ' ';

                  if (line.startsWith('@@')) {
                    // Hunk header - no line numbers
                  } else if (line.startsWith('+')) {
                    newLineNum++;
                    displayNewLine = String(newLineNum);
                    indicator = '+';
                  } else if (line.startsWith('-')) {
                    oldLineNum++;
                    displayOldLine = String(oldLineNum);
                    indicator = '-';
                  } else {
                    // Context line
                    oldLineNum++;
                    newLineNum++;
                    displayOldLine = String(oldLineNum);
                    displayNewLine = String(newLineNum);
                  }

                  const currentLine = newLineNum;
                  const anchorLine = line.startsWith('-') ? oldLineNum : newLineNum;
                  const anchorLineType: LineType = line.startsWith('-')
                    ? LineType.Old
                    : LineType.New;
                  // Frozen per-iteration snapshot — hunkIndex itself is a single mutable
                  // binding shared across the whole render pass, so closures (e.g. the
                  // click handler below) must not capture it directly.
                  const currentHunkIndex = hunkIndex;

                  // Renders the comment thread once, at the range's end line
                  const lineComments = fileComments.filter((c) => {
                    if (line.startsWith('@@')) return false;
                    const sideMatches = line.startsWith('-')
                      ? c.comment.line_type === LineType.Old
                      : c.comment.line_type !== LineType.Old;
                    return sideMatches && anchorLine === c.comment.end_line_number;
                  });

                  // Persistent highlight for every line within a saved comment's range
                  const isInSavedCommentRange = fileComments.some((c) => {
                    if (line.startsWith('@@')) return false;
                    const sideMatches = line.startsWith('-')
                      ? c.comment.line_type === LineType.Old
                      : c.comment.line_type !== LineType.Old;
                    return (
                      sideMatches &&
                      anchorLine >= c.comment.line_number &&
                      anchorLine <= c.comment.end_line_number
                    );
                  });

                  // Persistent highlight for the in-progress (not yet submitted) selection
                  const isInPendingSelection =
                    !!commentingAt &&
                    commentingAt.file === file.path &&
                    commentingAt.lineType === anchorLineType &&
                    anchorLine >= commentingAt.startLine &&
                    anchorLine <= commentingAt.endLine;

                  const rangeClass = isInPendingSelection
                    ? 'line-selecting'
                    : isInSavedCommentRange
                      ? 'line-in-comment-range'
                      : '';
                  const lineClasses = [
                    line.startsWith('+')
                      ? 'line-add'
                      : line.startsWith('-')
                        ? 'line-del'
                        : line.startsWith('@@')
                          ? 'line-hunk'
                          : 'line-ctx',
                    rangeClass,
                  ]
                    .filter(Boolean)
                    .join(' ');

                  // Check if this is the last line before next hunk or end of file
                  const nextHunkIdx = hunkStarts[hunkIndex + 1];
                  const isLastLineOfHunk =
                    nextHunkIdx !== undefined
                      ? idx === nextHunkIdx - 1
                      : idx === diffLines.length - 1;

                  // Context expansion keys
                  const expandUpKey = `${file.path}:${hunkIndex}:up`;
                  const expandDownKey = `${file.path}:${hunkIndex}:down`;
                  const expandedUpLines = expandedContext.get(expandUpKey) || [];
                  const expandedDownLines = expandedContext.get(expandDownKey) || [];

                  // Calculate how many more lines we've already expanded
                  const expandedUpCount = expandedUpLines.length;
                  const expandedDownCount = expandedDownLines.length;

                  return (
                    <div key={idx}>
                      {/* Hide @@ header, just show expand buttons */}
                      {!line.startsWith('@@') && (
                        <div className={`diff-line ${lineClasses}`}>
                          <span className={`line-num line-num-old ${lineClasses}`}>
                            {displayOldLine}
                          </span>
                          <span className={`line-num line-num-new ${lineClasses}`}>
                            {displayNewLine}
                          </span>
                          <span className={`line-indicator ${lineClasses}`}>{indicator}</span>
                          <span
                            className={`line-content ${lineClasses}`}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setCommentingAt({
                                  file: file.path,
                                  startLine: anchorLine,
                                  endLine: anchorLine,
                                  lineType: anchorLineType,
                                });
                                setLastClickedLine({
                                  file: file.path,
                                  hunkIndex: currentHunkIndex,
                                  line: anchorLine,
                                  lineType: anchorLineType,
                                });
                              }
                            }}
                            onClick={(e) => {
                              if (
                                e.shiftKey &&
                                lastClickedLine &&
                                lastClickedLine.file === file.path &&
                                lastClickedLine.hunkIndex === currentHunkIndex &&
                                lastClickedLine.lineType === anchorLineType
                              ) {
                                setCommentingAt({
                                  file: file.path,
                                  startLine: Math.min(lastClickedLine.line, anchorLine),
                                  endLine: Math.max(lastClickedLine.line, anchorLine),
                                  lineType: anchorLineType,
                                });
                                // Intentionally do not update lastClickedLine, so repeated
                                // shift-clicks keep extending from the original anchor.
                              } else {
                                setCommentingAt({
                                  file: file.path,
                                  startLine: anchorLine,
                                  endLine: anchorLine,
                                  lineType: anchorLineType,
                                });
                                setLastClickedLine({
                                  file: file.path,
                                  hunkIndex: currentHunkIndex,
                                  line: anchorLine,
                                  lineType: anchorLineType,
                                });
                              }
                            }}
                          >
                            <SyntaxLine
                              code={
                                line.startsWith('+') || line.startsWith('-') ? line.slice(1) : line
                              }
                              language={getLanguage(file.path)}
                            />
                          </span>
                        </div>
                      )}

                      {/* Expand up button - inside hunk, right after @@ header */}
                      {line.startsWith('@@') &&
                        hunkStartLine > 1 &&
                        hunkStartLine - expandedUpCount > 1 && (
                          <div className="expand-context-divider inside-hunk">
                            <button
                              className="expand-context-btn expand-up"
                              onClick={() => {
                                const linesToFetch = 10;
                                const end = hunkStartLine - expandedUpCount - 1;
                                const start = Math.max(1, end - linesToFetch + 1);
                                fetchContext(file.path, start, end, expandUpKey);
                              }}
                              title={`Show ${Math.min(10, hunkStartLine - expandedUpCount - 1)} more lines above`}
                            >
                              {loadingContext.has(expandUpKey) ? (
                                <MoreHorizontal size={10} />
                              ) : (
                                <Plus size={10} />
                              )}
                            </button>
                          </div>
                        )}

                      {/* Show already expanded lines above (after @@ header) */}
                      {line.startsWith('@@') &&
                        expandedUpLines.length > 0 &&
                        expandedUpLines.map((expandedLine, i) => {
                          const lineNum = hunkStartLine - expandedUpLines.length + i;
                          return (
                            <div
                              key={`expanded-up-${i}`}
                              className="diff-line line-ctx expanded-context"
                            >
                              <span className="line-num line-num-old line-ctx">{lineNum}</span>
                              <span className="line-num line-num-new line-ctx">{lineNum}</span>
                              <span className="line-indicator line-ctx"> </span>
                              <span className="line-content line-ctx">
                                <SyntaxLine code={expandedLine} language={getLanguage(file.path)} />
                              </span>
                            </div>
                          );
                        })}

                      {/* Inline comments with replies */}
                      {lineComments.map((commentWithReplies) => (
                        <CommentThread
                          key={commentWithReplies.comment.uuid}
                          item={commentWithReplies}
                          editingComment={editingComment}
                          setEditingComment={setEditingComment}
                          editComment={editComment}
                          resolveComment={resolveComment}
                          deleteComment={deleteComment}
                          replyingTo={replyingTo}
                          setReplyingTo={setReplyingTo}
                          replyContent={replyContent}
                          setReplyContent={setReplyContent}
                          addReply={addReply}
                        />
                      ))}

                      {/* New comment form */}
                      {commentingAt?.file === file.path &&
                        commentingAt?.lineType === anchorLineType &&
                        commentingAt?.endLine === anchorLine && (
                          <NewCommentForm
                            commentingAt={commentingAt}
                            newComment={newComment}
                            setNewComment={setNewComment}
                            addComment={addComment}
                            setCommentingAt={setCommentingAt}
                            setLastClickedLine={setLastClickedLine}
                          />
                        )}

                      {/* Expand down button at end of hunk */}
                      {isLastLineOfHunk && !line.startsWith('@@') && (
                        <>
                          {/* Show already expanded lines below */}
                          {expandedDownLines.map((expandedLine, i) => {
                            const lineNum = currentLine + i + 1;
                            return (
                              <div
                                key={`expanded-down-${i}`}
                                className="diff-line line-ctx expanded-context"
                              >
                                <span className="line-num line-num-old line-ctx">{lineNum}</span>
                                <span className="line-num line-num-new line-ctx">{lineNum}</span>
                                <span className="line-indicator line-ctx"> </span>
                                <span className="line-content line-ctx">
                                  <SyntaxLine
                                    code={expandedLine}
                                    language={getLanguage(file.path)}
                                  />
                                </span>
                              </div>
                            );
                          })}
                          {/* Expand down button - semicircle */}
                          <div className="expand-context-divider inside-hunk">
                            <button
                              className="expand-context-btn expand-down"
                              onClick={() => {
                                const linesToFetch = 10;
                                const start = currentLine + expandedDownCount + 1;
                                const end = start + linesToFetch - 1;
                                fetchContext(file.path, start, end, expandDownKey);
                              }}
                              title="Show 10 more lines below"
                            >
                              {loadingContext.has(expandDownKey) ? (
                                <MoreHorizontal size={10} />
                              ) : (
                                <Plus size={10} />
                              )}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
                {shouldLimit && (
                  <div
                    style={{
                      padding: '1rem',
                      textAlign: 'center',
                      background: '#161b22',
                      borderTop: '1px solid #30363d',
                    }}
                  >
                    <button
                      onClick={() => setShowAllLines((prev) => new Set(prev).add(file.path))}
                      style={{
                        padding: '0.5rem 1rem',
                        background: '#21262d',
                        color: '#58a6ff',
                        border: '1px solid #30363d',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '0.875rem',
                      }}
                    >
                      Show all {diffLines.length} lines ({diffLines.length - MAX_LINES_DEFAULT}{' '}
                      more)
                    </button>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
