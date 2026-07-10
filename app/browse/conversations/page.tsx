'use client';

import {
  MessageSquare,
  File,
  AlertCircle,
  CheckCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Trash2,
  Bot,
  Loader2,
  GitCommit,
} from 'lucide-react';
import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';
import RepoPathPicker from '@/components/browse/RepoPathPicker';
import { AuthorKind, ConversationStatus } from '@/lib/enum';
import { getRecentRepos, saveRecentRepo } from '@/lib/recent-repos';

interface ConversationMessage {
  uuid: string;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}

interface Conversation {
  id: number;
  uuid: string;
  repo_path: string;
  file_path: string;
  line_number: number;
  current_line_number: number | null;
  status: ConversationStatus;
  file_exists: boolean;
  created_at: string;
  updated_at: string;
  message_count?: number;
  latest_message?: ConversationMessage | null;
}

interface ConversationWithMessages {
  conversation: Conversation;
  messages: ConversationMessage[];
}

export default function ConversationsListPage() {
  const [repoPath, setRepoPath] = useState('');
  const [inputPath, setInputPath] = useState('');
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConversationStatus | 'all'>('all');
  const [expandedConversation, setExpandedConversation] = useState<string | null>(null);
  const [conversationMessages, setConversationMessages] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [replyContent, setReplyContent] = useState('');
  const [claudeResponding, setClaudeResponding] = useState<string | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const confirm = useConfirm();

  // Load recent repos on mount
  useEffect(() => {
    setRecentRepos(getRecentRepos());
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      setLoading(true);
      let url = `/api/browse/conversations?repo=${encodeURIComponent(repoPath)}`;
      if (filter !== 'all') {
        url += `&status=${filter}`;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load conversations');
      const data = await res.json();
      // Transform nested API response to flat conversation objects
      const flatConversations = (data.conversations || []).map(
        (item: ConversationWithMessages & { message_count?: number }) => ({
          ...item.conversation,
          message_count: item.message_count || item.messages?.length || 0,
          latest_message:
            item.messages?.length > 0 ? item.messages[item.messages.length - 1] : null,
        }),
      );
      setConversations(flatConversations);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading conversations');
    } finally {
      setLoading(false);
    }
  }, [repoPath, filter]);

  useEffect(() => {
    if (repoPath) {
      loadConversations();
    }
  }, [repoPath, filter, loadConversations]);

  // Poll for conversation updates (every 2 seconds)
  useEffect(() => {
    if (!repoPath) return;

    const pollConversations = async () => {
      try {
        let url = `/api/browse/conversations?repo=${encodeURIComponent(repoPath)}`;
        if (filter !== 'all') {
          url += `&status=${filter}`;
        }
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          // Transform nested API response to flat conversation objects
          const flatConversations = (data.conversations || []).map(
            (item: ConversationWithMessages & { message_count?: number }) => ({
              ...item.conversation,
              message_count: item.message_count || item.messages?.length || 0,
              latest_message:
                item.messages?.length > 0 ? item.messages[item.messages.length - 1] : null,
            }),
          );
          setConversations(flatConversations);
        }

        // Refresh expanded conversation messages
        if (expandedConversation) {
          const msgRes = await fetch(`/api/browse/conversations/${expandedConversation}/messages`);
          if (msgRes.ok) {
            const msgData = await msgRes.json();
            setConversationMessages((prev) => ({
              ...prev,
              [expandedConversation]: msgData.messages,
            }));
          }
        }
      } catch (e) {
        // Silently fail on poll errors
        console.error('Poll error:', e);
      }
    };

    const interval = setInterval(pollConversations, 2000);
    return () => clearInterval(interval);
  }, [repoPath, filter, expandedConversation]);

  const loadConversationMessages = async (uuid: string) => {
    try {
      const res = await fetch(`/api/browse/conversations/${uuid}/messages`);
      if (!res.ok) throw new Error('Failed to load conversation');
      const data: ConversationWithMessages = await res.json();
      setConversationMessages((prev) => ({
        ...prev,
        [uuid]: data.messages,
      }));
    } catch (e) {
      console.error('Error loading conversation:', e);
    }
  };

  const handleSetRepo = (path?: string) => {
    const newPath = path || inputPath.trim();
    if (newPath) {
      setRepoPath(newPath);
      setConversations([]);
      saveRecentRepo(newPath);
      setRecentRepos(getRecentRepos());
    }
  };

  const resolveConversation = async (uuid: string) => {
    try {
      const res = await fetch('/api/browse/conversations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid, status: ConversationStatus.Resolved }),
      });
      if (!res.ok) throw new Error('Failed to resolve conversation');
      await loadConversations();
    } catch (e) {
      console.error('Error resolving conversation:', e);
    }
  };

  const deleteConversation = async (uuid: string) => {
    if (!(await confirm('Are you sure you want to delete this conversation?', { danger: true })))
      return;

    try {
      const res = await fetch(`/api/browse/conversations?uuid=${uuid}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete conversation');
      await loadConversations();
    } catch (e) {
      console.error('Error deleting conversation:', e);
    }
  };

  const respondWithClaude = async (conversationUuid: string, autoCommit: boolean = false) => {
    setClaudeResponding(conversationUuid);
    setClaudeError(null);

    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'respond',
          conversationUuid,
          allowEdits: true,
          autoCommit,
          push: false,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to get Claude response');
      }

      // Reload conversation messages to show Claude's response
      await loadConversationMessages(conversationUuid);

      // Show commit info if changes were made
      if (data.hasChanges && !autoCommit) {
        setClaudeError(
          `Claude made changes. Use "Respond & Commit" to auto-commit, or commit manually.`,
        );
      } else if (data.commit?.success) {
        setClaudeError(`Changes committed: ${data.commit.commitHash?.slice(0, 7)}`);
      }
    } catch (e) {
      console.error('Error getting Claude response:', e);
      setClaudeError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setClaudeResponding(null);
    }
  };

  const addReply = async (conversationUuid: string, triggerClaude: boolean = true) => {
    if (!replyContent.trim()) return;

    try {
      const res = await fetch(`/api/browse/conversations/${conversationUuid}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: replyContent,
        }),
      });

      if (!res.ok) throw new Error('Failed to add reply');

      // Reload conversation messages
      await loadConversationMessages(conversationUuid);
      setReplyContent('');

      // Auto-trigger Claude to respond
      if (triggerClaude) {
        respondWithClaude(conversationUuid, false);
      }
    } catch (e) {
      console.error('Error adding reply:', e);
    }
  };

  const toggleConversation = (uuid: string) => {
    if (expandedConversation === uuid) {
      setExpandedConversation(null);
    } else {
      setExpandedConversation(uuid);
      if (!conversationMessages[uuid]) {
        loadConversationMessages(uuid);
      }
    }
  };

  const getStatusIcon = (conv: Conversation) => {
    if (conv.status === ConversationStatus.Resolved) {
      return <CheckCircle size={14} className="status-icon resolved" />;
    }
    if (conv.status === ConversationStatus.Orphaned || !conv.file_exists) {
      return <AlertCircle size={14} className="status-icon orphaned" />;
    }
    return <Clock size={14} className="status-icon active" />;
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const groupedConversations = conversations.reduce(
    (acc, conv) => {
      const filePath = conv.file_path;
      if (!acc[filePath]) {
        acc[filePath] = [];
      }
      acc[filePath].push(conv);
      return acc;
    },
    {} as Record<string, Conversation[]>,
  );

  return (
    <main className="container conversations-list-page">
      {/* Repo Path Input */}
      {!repoPath && (
        <RepoPathPicker
          heading="All Conversations"
          description="Enter the path to a repository to view all conversations."
          submitLabel="View Conversations"
          inputPath={inputPath}
          onInputPathChange={setInputPath}
          onSubmit={handleSetRepo}
          recentRepos={recentRepos}
        />
      )}

      {repoPath && (
        <div className="conversations-layout">
          <div className="conversations-header">
            <div className="header-left">
              <h1>Conversations</h1>
              <span className="repo-name">{repoPath.split('/').pop()}</span>
              <button
                className="change-repo-btn"
                onClick={() => {
                  setRepoPath('');
                  setInputPath('');
                  setConversations([]);
                }}
              >
                Change
              </button>
            </div>
            <div className="filter-tabs">
              {(['all', ...Object.values(ConversationStatus)] as const).map((f) => (
                <button
                  key={f}
                  className={`filter-tab ${filter === f ? 'active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                  {f === 'all' && conversations.length > 0 && (
                    <span className="count">{conversations.length}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {loading && <div className="loading">Loading conversations...</div>}
          {error && <div className="error">{error}</div>}

          {!loading && conversations.length === 0 && (
            <div className="no-conversations">
              <MessageSquare size={48} />
              <p>No conversations found</p>
              <Link href="/browse" className="browse-link">
                Browse files to start a conversation
              </Link>
            </div>
          )}

          {!loading && Object.keys(groupedConversations).length > 0 && (
            <div className="conversations-grouped">
              {Object.entries(groupedConversations).map(([filePath, convs]) => (
                <div key={filePath} className="file-group">
                  <div className="file-group-header">
                    <File size={14} />
                    <span className="file-path">{filePath}</span>
                    <span className="conv-count">
                      {convs.length} conversation{convs.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="file-conversations">
                    {convs.map((conv, idx) => (
                      <div
                        key={`${conv.uuid}-${idx}`}
                        className={`conversation-item ${conv.status} ${expandedConversation === conv.uuid ? 'expanded' : ''}`}
                      >
                        <div
                          className="conversation-summary"
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleConversation(conv.uuid)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleConversation(conv.uuid);
                            }
                          }}
                        >
                          <div className="summary-left">
                            {expandedConversation === conv.uuid ? (
                              <ChevronDown size={14} />
                            ) : (
                              <ChevronRight size={14} />
                            )}
                            {getStatusIcon(conv)}
                            <span className="line-number">
                              Line {conv.current_line_number || conv.line_number}
                            </span>
                            {conv.current_line_number &&
                              conv.current_line_number !== conv.line_number && (
                                <span className="line-moved">(was {conv.line_number})</span>
                              )}
                          </div>
                          <div className="summary-right">
                            <span className="message-count">
                              <MessageSquare size={12} />
                              {conv.message_count || 0}
                            </span>
                            <span className="date">{formatDate(conv.created_at)}</span>
                          </div>
                        </div>

                        {conv.latest_message && expandedConversation !== conv.uuid && (
                          <div className="conversation-preview">
                            <span className="preview-author">{conv.latest_message.author}:</span>
                            <span className="preview-content">{conv.latest_message.content}</span>
                          </div>
                        )}

                        {expandedConversation === conv.uuid && conversationMessages[conv.uuid] && (
                          <div className="conversation-messages">
                            {conversationMessages[conv.uuid].map((msg) => (
                              <div
                                key={msg.uuid}
                                className={`message ${msg.author_kind === AuthorKind.Agent ? 'message-claude' : 'message-user'}`}
                              >
                                <span className="message-author">{msg.author}</span>
                                <span className="message-content">{msg.content}</span>
                                <span className="message-time">{formatDate(msg.created_at)}</span>
                              </div>
                            ))}
                            {conv.status !== ConversationStatus.Resolved && (
                              <div className="reply-form-inline">
                                <textarea
                                  placeholder="Write a reply..."
                                  value={replyContent}
                                  onChange={(e) => setReplyContent(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                      e.preventDefault();
                                      addReply(conv.uuid);
                                    }
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <button
                                  className="send-reply-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    addReply(conv.uuid);
                                  }}
                                >
                                  Send
                                </button>
                              </div>
                            )}
                            {claudeError && expandedConversation === conv.uuid && (
                              <div className="claude-status-message">{claudeError}</div>
                            )}
                            <div className="conversation-actions">
                              {conv.status !== ConversationStatus.Resolved && conv.file_exists && (
                                <>
                                  <button
                                    className="claude-respond-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      respondWithClaude(conv.uuid, false);
                                    }}
                                    disabled={claudeResponding === conv.uuid}
                                  >
                                    {claudeResponding === conv.uuid ? (
                                      <Loader2 size={14} className="spinning" />
                                    ) : (
                                      <Bot size={14} />
                                    )}
                                    {claudeResponding === conv.uuid ? 'Thinking...' : 'Ask Claude'}
                                  </button>
                                  <button
                                    className="claude-respond-commit-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      respondWithClaude(conv.uuid, true);
                                    }}
                                    disabled={claudeResponding === conv.uuid}
                                  >
                                    {claudeResponding === conv.uuid ? (
                                      <Loader2 size={14} className="spinning" />
                                    ) : (
                                      <GitCommit size={14} />
                                    )}
                                    Ask & Commit
                                  </button>
                                </>
                              )}
                              {conv.status !== ConversationStatus.Resolved && (
                                <button
                                  className="resolve-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    resolveConversation(conv.uuid);
                                  }}
                                >
                                  <CheckCircle size={14} />
                                  Resolve
                                </button>
                              )}
                              <button
                                className="delete-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteConversation(conv.uuid);
                                }}
                              >
                                <Trash2 size={14} />
                                Delete
                              </button>
                              {conv.file_exists && (
                                <Link
                                  href={`/browse?repo=${encodeURIComponent(repoPath)}&file=${encodeURIComponent(conv.file_path)}&line=${conv.current_line_number || conv.line_number}`}
                                  className="view-file-btn"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <File size={14} />
                                  View in File
                                </Link>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
