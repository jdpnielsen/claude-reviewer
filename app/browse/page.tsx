'use client';

import { useEffect, useMemo, useState } from 'react';

import type { ConversationMessage } from './types';
import BrowseSidebar from '@/components/browse/BrowseSidebar';
import FileViewer from '@/components/browse/FileViewer';
import RepoPathPicker from '@/components/browse/RepoPathPicker';
import { AuthorKind, ConversationStatus } from '@/lib/enum';
import {
  useBrowseFileQuery,
  useBrowseTreeQuery,
  useLoadFolderChildrenMutation,
} from '@/lib/queries/browse';
import {
  useAddCommentMutation,
  useAddReplyMutation,
  useConversationMessagesQueries,
  useResolveConversationMutation,
  useRespondWithClaudeAsyncMutation,
} from '@/lib/queries/conversations';
import { getRecentRepos, saveRecentRepo } from '@/lib/recent-repos';

export default function BrowsePage() {
  const [repoPath, setRepoPath] = useState('');
  const [inputPath, setInputPath] = useState('');
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Load recent repos on mount
  useEffect(() => {
    setRecentRepos(getRecentRepos());
  }, []);

  // Comment state
  const [commentingAt, setCommentingAt] = useState<number | null>(null);
  const [newComment, setNewComment] = useState('');
  const [replyContent, setReplyContent] = useState('');
  const [claudeResponding, setClaudeResponding] = useState<Set<string>>(new Set());

  const treeQuery = useBrowseTreeQuery(repoPath);
  const fileQuery = useBrowseFileQuery(repoPath, selectedFile);
  const loadFolderChildrenMutation = useLoadFolderChildrenMutation(repoPath);
  const addCommentMutation = useAddCommentMutation();
  const addReplyMutation = useAddReplyMutation();
  const resolveConversationMutation = useResolveConversationMutation();
  const respondMutation = useRespondWithClaudeAsyncMutation();

  const tree = treeQuery.data?.tree ?? null;
  const fileContent = fileQuery.data?.lines ?? [];
  const fileConversations = useMemo(() => fileQuery.data?.conversations ?? [], [fileQuery.data]);
  const loading = treeQuery.isLoading || fileQuery.isLoading;
  const error = fileQuery.error?.message ?? treeQuery.error?.message ?? null;

  // Auto-expand root folder whenever the repo (and so the root tree) changes
  useEffect(() => {
    if (repoPath) {
      setExpandedFolders(new Set(['']));
    }
  }, [repoPath]);

  const messagesQueries = useConversationMessagesQueries(fileConversations.map((c) => c.uuid));

  const conversationMessages = useMemo(() => {
    const map: Record<string, ConversationMessage[]> = {};
    fileConversations.forEach((conv, idx) => {
      const data = messagesQueries[idx]?.data;
      if (data) {
        map[conv.uuid] = data.messages;
      }
    });
    return map;
  }, [fileConversations, messagesQueries]);

  // Claude has "responded" once the latest message in a conversation is
  // agent-authored - drop it from the pending set when that happens.
  useEffect(() => {
    setClaudeResponding((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const uuid of prev) {
        const messages = conversationMessages[uuid];
        if (messages?.length && messages[messages.length - 1].author_kind === AuthorKind.Agent) {
          next.delete(uuid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [conversationMessages]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // Load children if not already loaded
        loadFolderChildrenMutation.mutate(path);
      }
      return next;
    });
  };

  const handleSetRepo = (path?: string) => {
    const newPath = path || inputPath.trim();
    if (newPath) {
      setRepoPath(newPath);
      setSelectedFile(null);
      saveRecentRepo(newPath);
      setRecentRepos(getRecentRepos());
    }
  };

  const respondWithClaude = (conversationUuid: string) => {
    // Add to set of pending responses
    setClaudeResponding((prev) => new Set(prev).add(conversationUuid));

    // Use async mode so Claude processes in background even if user navigates away.
    // Polling will remove from claudeResponding when Claude's response arrives.
    respondMutation.mutate(conversationUuid, {
      onError: () => {
        // Remove from pending on error
        setClaudeResponding((prev) => {
          const next = new Set(prev);
          next.delete(conversationUuid);
          return next;
        });
      },
    });
  };

  const addComment = () => {
    if (!commentingAt || !newComment.trim() || !selectedFile) return;

    addCommentMutation.mutate(
      { repo: repoPath, filePath: selectedFile, lineNumber: commentingAt, content: newComment },
      {
        onSuccess: (data) => {
          setCommentingAt(null);
          setNewComment('');

          // Auto-trigger Claude to respond to the new conversation
          if (data.uuid) {
            respondWithClaude(data.uuid);
          }
        },
      },
    );
  };

  const addReply = (conversationUuid: string) => {
    if (!replyContent.trim()) return;

    addReplyMutation.mutate(
      { conversationUuid, content: replyContent },
      {
        onSuccess: () => {
          setReplyContent('');
          // Auto-trigger Claude to respond
          respondWithClaude(conversationUuid);
        },
      },
    );
  };

  const resolveConversation = (uuid: string) => {
    resolveConversationMutation.mutate(uuid);
  };

  const getLineConversations = (lineNumber: number) => {
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
            onSelectFile={setSelectedFile}
            onChangeRepo={() => {
              setRepoPath('');
              setInputPath('');
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
