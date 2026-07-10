'use client';

import { useState, useEffect, useCallback } from 'react';

import type { Conversation, ConversationMessage, ConversationWithMessages, TreeNode } from './types';
import BrowseSidebar from '@/components/browse/BrowseSidebar';
import FileViewer from '@/components/browse/FileViewer';
import RepoPathPicker from '@/components/browse/RepoPathPicker';
import { AuthorKind, ConversationStatus } from '@/lib/enum';
import { getRecentRepos, saveRecentRepo } from '@/lib/recent-repos';

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
          <BrowseSidebar
            repoPath={repoPath}
            tree={tree}
            expandedFolders={expandedFolders}
            selectedFile={selectedFile}
            onToggleFolder={toggleFolder}
            onSelectFile={loadFile}
            onChangeRepo={() => {
              setRepoPath('');
              setInputPath('');
              setTree(null);
              setSelectedFile(null);
            }}
          />

          <FileViewer
            selectedFile={selectedFile}
            fileContent={fileContent}
            loading={loading}
            error={error}
            getLineConversations={getLineConversations}
            conversationMessages={conversationMessages}
            claudeResponding={claudeResponding}
            commentingAt={commentingAt}
            newComment={newComment}
            onLineClick={setCommentingAt}
            onNewCommentChange={setNewComment}
            onCancelComment={() => setCommentingAt(null)}
            onAddComment={addComment}
            onResolveConversation={resolveConversation}
            replyContent={replyContent}
            onReplyChange={setReplyContent}
            onAddReply={addReply}
          />
        </div>
      )}
    </main>
  );
}
