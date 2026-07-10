'use client';

import { AlertCircle, CheckCircle, File, Loader2, MessageSquare, Send } from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';

import type { Conversation, ConversationMessage } from '@/app/browse/types';
import { getLanguage, githubDarkTheme } from '@/app/browse/utils';
import { AuthorKind, ConversationStatus } from '@/lib/enum';

interface FileViewerProps {
  selectedFile: string | null;
  fileContent: string[];
  loading: boolean;
  error: string | null;
  getLineConversations: (lineNumber: number) => Conversation[];
  conversationMessages: Record<string, ConversationMessage[]>;
  claudeResponding: Set<string>;
  commentingAt: number | null;
  newComment: string;
  onLineClick: (lineNumber: number) => void;
  onNewCommentChange: (value: string) => void;
  onCancelComment: () => void;
  onAddComment: () => void;
  onResolveConversation: (uuid: string) => void;
  replyContent: string;
  onReplyChange: (value: string) => void;
  onAddReply: (conversationUuid: string) => void;
}

export default function FileViewer({
  selectedFile,
  fileContent,
  loading,
  error,
  getLineConversations,
  conversationMessages,
  claudeResponding,
  commentingAt,
  newComment,
  onLineClick,
  onNewCommentChange,
  onCancelComment,
  onAddComment,
  onResolveConversation,
  replyContent,
  onReplyChange,
  onAddReply,
}: FileViewerProps) {
  return (
    <div className="browse-main">
      {loading && <div className="loading">Loading...</div>}
      {error && <div className="error">{error}</div>}

      {!selectedFile && !loading && (
        <div className="no-file-selected">
          <File size={48} />
          <p>Select a file to view</p>
        </div>
      )}

      {selectedFile && fileContent.length > 0 && (
        <div className="file-viewer">
          <div className="file-header">
            <File size={16} />
            <span>{selectedFile}</span>
          </div>
          <div className="file-content">
            <Highlight
              theme={githubDarkTheme as typeof themes.dracula}
              code={fileContent.join('\n')}
              language={getLanguage(selectedFile)}
            >
              {({ style, tokens, getLineProps, getTokenProps }) => (
                <pre style={{ ...style, margin: 0, padding: '1rem', background: 'transparent' }}>
                  {tokens.map((line, lineIdx) => {
                    const lineNumber = lineIdx + 1;
                    const lineConversations = getLineConversations(lineNumber);

                    return (
                      <div key={lineIdx}>
                        <div
                          {...getLineProps({ line })}
                          className="code-line"
                          role="button"
                          tabIndex={0}
                          onClick={() => onLineClick(lineNumber)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onLineClick(lineNumber);
                            }
                          }}
                        >
                          <span className="line-number">{lineNumber}</span>
                          <span className="line-content">
                            {line.map((token, tokenIdx) => (
                              <span key={tokenIdx} {...getTokenProps({ token })} />
                            ))}
                          </span>
                          {lineConversations.length > 0 && (
                            <span className="line-comment-indicator">
                              <MessageSquare size={12} />
                            </span>
                          )}
                        </div>

                        {/* Comment Form */}
                        {commentingAt === lineNumber && (
                          <div className="new-comment-form">
                            <textarea
                              placeholder="Add a comment..."
                              value={newComment}
                              onChange={(e) => onNewCommentChange(e.target.value)}
                              ref={(el) => el?.focus()}
                            />
                            <div className="comment-form-actions">
                              <button onClick={onCancelComment}>Cancel</button>
                              <button className="primary" onClick={onAddComment}>
                                <Send size={14} />
                                Comment
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Existing Conversations */}
                        {lineConversations.map((conv) => (
                          <div
                            key={conv.uuid}
                            className={`inline-comment ${conv.status === ConversationStatus.Orphaned ? 'orphaned' : ''}`}
                          >
                            <div className="comment-header">
                              <span className="comment-meta">
                                {conv.status === ConversationStatus.Orphaned && (
                                  <span className="orphaned-badge">
                                    <AlertCircle size={12} />
                                    Line changed
                                  </span>
                                )}
                                {conv.message_count} message
                                {conv.message_count !== 1 ? 's' : ''}
                              </span>
                              <div className="comment-actions">
                                <button onClick={() => onResolveConversation(conv.uuid)}>
                                  <CheckCircle size={14} />
                                  Resolve
                                </button>
                              </div>
                            </div>

                            {/* Full conversation - always visible */}
                            {conversationMessages[conv.uuid] && (
                              <div className="conversation-thread">
                                {conversationMessages[conv.uuid].map((msg) => (
                                  <div
                                    key={msg.uuid}
                                    className={`comment-reply ${msg.author_kind === AuthorKind.Agent ? 'reply-claude' : 'reply-human'}`}
                                  >
                                    <span className="reply-author">{msg.author}:</span>
                                    <span className="reply-content">{msg.content}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Claude thinking indicator */}
                            {claudeResponding.has(conv.uuid) && (
                              <div className="claude-thinking">
                                <Loader2 size={14} className="spinning" />
                                <span>Claude is thinking...</span>
                              </div>
                            )}

                            {/* Reply form - always visible for active conversations */}
                            {conv.status !== ConversationStatus.Resolved && (
                              <div className="reply-form">
                                <textarea
                                  placeholder="Reply..."
                                  value={replyContent}
                                  onChange={(e) => onReplyChange(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                      e.preventDefault();
                                      onAddReply(conv.uuid);
                                    }
                                  }}
                                  disabled={claudeResponding.has(conv.uuid)}
                                />
                                <button
                                  onClick={() => onAddReply(conv.uuid)}
                                  disabled={claudeResponding.has(conv.uuid)}
                                >
                                  <Send size={14} />
                                  Reply
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </pre>
              )}
            </Highlight>
          </div>
        </div>
      )}
    </div>
  );
}
