'use client';

import {
  Folder,
  FolderOpen,
  File,
  ChevronDown,
  MessageSquare,
  Send,
  CheckCircle,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';
import { useState, useEffect, useCallback } from 'react';

import RepoPathPicker from '@/components/browse/RepoPathPicker';
import { AuthorKind, ConversationStatus } from '@/lib/enum';
import { getRecentRepos, saveRecentRepo } from '@/lib/recent-repos';

// Types
interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
  conversationCount?: number;
}

interface ConversationMessage {
  uuid: string;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}

interface Conversation {
  uuid: string;
  line_number: number;
  current_line_number: number | null;
  status: ConversationStatus;
  message_count: number;
  latest_message: ConversationMessage | null;
}

interface ConversationWithMessages {
  conversation: {
    uuid: string;
    file_path: string;
    line_number: number;
    current_line_number: number | null;
    status: ConversationStatus;
  };
  messages: ConversationMessage[];
}

// Language detection for syntax highlighting
const getLanguage = (filePath: string): string => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    go: 'go',
    rs: 'rust',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    html: 'markup',
    xml: 'markup',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
  };
  return langMap[ext] || 'text';
};

// GitHub-like dark theme
const githubDarkTheme = {
  plain: {
    color: '#e6edf3',
    backgroundColor: '#0d1117',
  },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#8b949e' } },
    { types: ['punctuation'], style: { color: '#c9d1d9' } },
    {
      types: ['property', 'tag', 'boolean', 'number', 'constant', 'symbol'],
      style: { color: '#79c0ff' },
    },
    { types: ['selector', 'attr-name', 'string', 'char', 'builtin'], style: { color: '#a5d6ff' } },
    { types: ['operator', 'entity', 'url'], style: { color: '#c9d1d9' } },
    { types: ['atrule', 'attr-value', 'keyword'], style: { color: '#ff7b72' } },
    { types: ['function', 'class-name'], style: { color: '#d2a8ff' } },
    { types: ['regex', 'important', 'variable'], style: { color: '#ffa657' } },
  ],
};

export default function BrowsePage() {
  const [repoPath, setRepoPath] = useState('');
  const [inputPath, setInputPath] = useState('');
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string[]>([]);
  const [fileConversations, setFileConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load recent repos on mount
  useEffect(() => {
    setRecentRepos(getRecentRepos());
  }, []);

  // Comment state
  const [commentingAt, setCommentingAt] = useState<number | null>(null);
  const [newComment, setNewComment] = useState('');
  const [conversationMessages, setConversationMessages] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [replyContent, setReplyContent] = useState('');
  const [claudeResponding, setClaudeResponding] = useState<Set<string>>(new Set());

  const loadTree = useCallback(
    async (subPath: string = '') => {
      try {
        setLoading(true);
        const url = `/api/browse/tree?repo=${encodeURIComponent(repoPath)}&path=${encodeURIComponent(subPath)}&depth=2`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load tree');
        const data = await res.json();
        setTree(data.tree);
        // Auto-expand root folder (path is empty string for root)
        if (data.tree) {
          setExpandedFolders(new Set([data.tree.path ?? '']));
        }
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error loading tree');
      } finally {
        setLoading(false);
      }
    },
    [repoPath],
  );

  // Load tree when repo path changes
  useEffect(() => {
    if (repoPath) {
      loadTree();
    }
  }, [repoPath, loadTree]);

  // Poll for conversation updates (every 2 seconds when a file is selected)
  useEffect(() => {
    if (!selectedFile || !repoPath) return;

    const pollConversations = async () => {
      try {
        // Refresh file conversations
        const url = `/api/browse/file?repo=${encodeURIComponent(repoPath)}&path=${encodeURIComponent(selectedFile)}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const convs = data.conversations || [];
          setFileConversations(convs);

          // Refresh messages for all conversations
          for (const conv of convs) {
            const msgRes = await fetch(`/api/browse/conversations/${conv.uuid}/messages`);
            if (msgRes.ok) {
              const msgData = await msgRes.json();
              const messages = msgData.messages || [];
              setConversationMessages((prev) => ({
                ...prev,
                [conv.uuid]: messages,
              }));

              // Check if Claude has responded - remove from pending if last message is from Claude
              if (
                messages.length > 0 &&
                messages[messages.length - 1].author_kind === AuthorKind.Agent
              ) {
                setClaudeResponding((prev) => {
                  if (prev.has(conv.uuid)) {
                    const next = new Set(prev);
                    next.delete(conv.uuid);
                    return next;
                  }
                  return prev;
                });
              }
            }
          }
        }
      } catch (e) {
        // Silently fail on poll errors
        console.error('Poll error:', e);
      }
    };

    const interval = setInterval(pollConversations, 2000);
    return () => clearInterval(interval);
  }, [selectedFile, repoPath]);

  const loadFile = async (filePath: string) => {
    try {
      setLoading(true);
      setSelectedFile(filePath);
      const url = `/api/browse/file?repo=${encodeURIComponent(repoPath)}&path=${encodeURIComponent(filePath)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load file');
      const data = await res.json();
      setFileContent(data.lines);
      setFileConversations(data.conversations || []);

      // Auto-load messages for all conversations
      const convs = data.conversations || [];
      for (const conv of convs) {
        loadConversationMessages(conv.uuid);
      }

      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading file');
    } finally {
      setLoading(false);
    }
  };

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

  const loadFolderChildren = async (folderPath: string) => {
    try {
      const url = `/api/browse/tree?repo=${encodeURIComponent(repoPath)}&path=${encodeURIComponent(folderPath)}&depth=2`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      if (data.tree && data.tree.children) {
        // Update tree with new children
        setTree((prevTree) => {
          if (!prevTree) return prevTree;

          const updateNode = (node: TreeNode): TreeNode => {
            if (node.path === folderPath) {
              return { ...node, children: data.tree.children };
            }
            if (node.children) {
              return { ...node, children: node.children.map(updateNode) };
            }
            return node;
          };

          return updateNode(prevTree);
        });
      }
    } catch (e) {
      console.error('Error loading folder children:', e);
    }
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // Load children if not already loaded
        loadFolderChildren(path);
      }
      return next;
    });
  };

  const handleSetRepo = (path?: string) => {
    const newPath = path || inputPath.trim();
    if (newPath) {
      setRepoPath(newPath);
      setSelectedFile(null);
      setFileContent([]);
      setTree(null);
      saveRecentRepo(newPath);
      setRecentRepos(getRecentRepos());
    }
  };

  const respondWithClaude = async (conversationUuid: string) => {
    // Add to set of pending responses
    setClaudeResponding((prev) => new Set(prev).add(conversationUuid));

    try {
      // Use async mode so Claude processes in background even if user navigates away
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'respond',
          conversationUuid,
          allowEdits: true,
          autoCommit: false,
          push: false,
          async: true, // Fire-and-forget mode
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to trigger Claude response');
      }

      // Response is processing in background
      // Polling will remove from claudeResponding when Claude's response arrives
    } catch (e) {
      console.error('Error triggering Claude response:', e);
      // Remove from pending on error
      setClaudeResponding((prev) => {
        const next = new Set(prev);
        next.delete(conversationUuid);
        return next;
      });
    }
  };

  const addComment = async () => {
    if (!commentingAt || !newComment.trim() || !selectedFile) return;

    try {
      const res = await fetch('/api/browse/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: repoPath,
          filePath: selectedFile,
          lineNumber: commentingAt,
          content: newComment,
        }),
      });

      if (!res.ok) throw new Error('Failed to add comment');
      const data = await res.json();

      // Reload file to get updated conversations
      await loadFile(selectedFile);
      setCommentingAt(null);
      setNewComment('');

      // Auto-trigger Claude to respond to the new conversation
      if (data.uuid) {
        respondWithClaude(data.uuid);
      }
    } catch (e) {
      console.error('Error adding comment:', e);
    }
  };

  const addReply = async (conversationUuid: string) => {
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
      respondWithClaude(conversationUuid);
    } catch (e) {
      console.error('Error adding reply:', e);
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

      // Reload file
      if (selectedFile) {
        await loadFile(selectedFile);
      }
    } catch (e) {
      console.error('Error resolving conversation:', e);
    }
  };

  // Render tree node recursively
  const renderTreeNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.path);
    const indent = depth * 16;

    if (node.type === 'directory') {
      return (
        <div key={node.path}>
          <button
            className={`folder-item ${isExpanded ? '' : 'collapsed'}`}
            onClick={() => toggleFolder(node.path)}
            style={{ paddingLeft: `${indent + 8}px` }}
          >
            <ChevronDown size={12} className="folder-icon" />
            {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
            <span>{node.name}</span>
          </button>
          {isExpanded && node.children && (
            <div>{node.children.map((child) => renderTreeNode(child, depth + 1))}</div>
          )}
        </div>
      );
    }

    return (
      <button
        key={node.path}
        className={`file-item ${selectedFile === node.path ? 'active' : ''}`}
        onClick={() => loadFile(node.path)}
        style={{ paddingLeft: `${indent + 8}px` }}
      >
        <File size={14} />
        <span className="file-name">{node.name}</span>
        {node.conversationCount && node.conversationCount > 0 && (
          <span className="conversation-badge">
            <MessageSquare size={10} />
            {node.conversationCount}
          </span>
        )}
      </button>
    );
  };

  const getLineConversations = (lineNumber: number): Conversation[] => {
    return fileConversations.filter(
      (c) =>
        (c.current_line_number || c.line_number) === lineNumber &&
        c.status !== ConversationStatus.Resolved,
    );
  };

  return (
    <main className="container browse-page">
      {/* Repo Path Input */}
      {!repoPath && (
        <RepoPathPicker
          heading="Browse Repository"
          description="Enter the path to a local repository to browse and add comments."
          submitLabel="Browse"
          inputPath={inputPath}
          onInputPathChange={setInputPath}
          onSubmit={handleSetRepo}
          recentRepos={recentRepos}
        />
      )}

      {/* Browse Layout */}
      {repoPath && (
        <div className="browse-layout">
          {/* Sidebar */}
          <aside className="browse-sidebar">
            <div className="sidebar-section">
              <div className="sidebar-header">
                <h3>Files</h3>
                <button
                  className="change-repo-btn"
                  onClick={() => {
                    setRepoPath('');
                    setInputPath('');
                    setTree(null);
                    setSelectedFile(null);
                  }}
                >
                  Change
                </button>
              </div>
              <div className="repo-path-display">{repoPath.split('/').pop()}</div>
              <div className="file-list">{tree && renderTreeNode(tree)}</div>
            </div>
          </aside>

          {/* Main Content */}
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
                      <pre
                        style={{ ...style, margin: 0, padding: '1rem', background: 'transparent' }}
                      >
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
                                onClick={() => setCommentingAt(lineNumber)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setCommentingAt(lineNumber);
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
                                    onChange={(e) => setNewComment(e.target.value)}
                                    ref={(el) => el?.focus()}
                                  />
                                  <div className="comment-form-actions">
                                    <button onClick={() => setCommentingAt(null)}>Cancel</button>
                                    <button className="primary" onClick={addComment}>
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
                                      <button onClick={() => resolveConversation(conv.uuid)}>
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
                                        onChange={(e) => setReplyContent(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            addReply(conv.uuid);
                                          }
                                        }}
                                        disabled={claudeResponding.has(conv.uuid)}
                                      />
                                      <button
                                        onClick={() => addReply(conv.uuid)}
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
        </div>
      )}
    </main>
  );
}
