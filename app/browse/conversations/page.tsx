'use client';

import { MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import type { Conversation, ConversationMessage } from './types';
import ConversationGroups from '@/components/browse/ConversationGroups';
import ConversationsHeader from '@/components/browse/ConversationsHeader';
import RepoPathPicker from '@/components/browse/RepoPathPicker';
import { useConfirm } from '@/components/ConfirmDialog';
import { ConversationStatus } from '@/lib/enum';
import {
  useAddReplyMutation,
  useConversationMessagesQuery,
  useConversationsQuery,
  useDeleteConversationMutation,
  useResolveConversationMutation,
  useRespondWithClaudeMutation,
} from '@/lib/queries/conversations';
import { getRecentRepos, saveRecentRepo } from '@/lib/recent-repos';

export default function ConversationsListPage() {
  const [repoPath, setRepoPath] = useState('');
  const [inputPath, setInputPath] = useState('');
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  const [filter, setFilter] = useState<ConversationStatus | 'all'>('all');
  const [expandedConversation, setExpandedConversation] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [claudeResponding, setClaudeResponding] = useState<string | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const confirm = useConfirm();

  // Load recent repos on mount
  useEffect(() => {
    setRecentRepos(getRecentRepos());
  }, []);

  const conversationsQuery = useConversationsQuery(repoPath, filter);
  const messagesQuery = useConversationMessagesQuery(expandedConversation);
  const addReplyMutation = useAddReplyMutation();
  const resolveConversationMutation = useResolveConversationMutation();
  const deleteConversationMutation = useDeleteConversationMutation();
  const respondMutation = useRespondWithClaudeMutation();

  const conversations = conversationsQuery.data?.conversations ?? [];
  const loading = conversationsQuery.isLoading;
  const error = conversationsQuery.error?.message ?? null;

  const conversationMessages = useMemo(() => {
    if (!expandedConversation || !messagesQuery.data) return {};
    return { [expandedConversation]: messagesQuery.data.messages } as Record<
      string,
      ConversationMessage[]
    >;
  }, [expandedConversation, messagesQuery.data]);

  const handleSetRepo = (path?: string) => {
    const newPath = path || inputPath.trim();
    if (newPath) {
      setRepoPath(newPath);
      saveRecentRepo(newPath);
      setRecentRepos(getRecentRepos());
    }
  };

  const resolveConversation = (uuid: string) => {
    resolveConversationMutation.mutate(uuid);
  };

  const deleteConversation = async (uuid: string) => {
    if (!(await confirm('Are you sure you want to delete this conversation?', { danger: true })))
      return;

    deleteConversationMutation.mutate(uuid);
  };

  const respondWithClaude = (conversationUuid: string, autoCommit: boolean = false) => {
    setClaudeResponding(conversationUuid);
    setClaudeError(null);

    respondMutation.mutate(
      { conversationUuid, autoCommit },
      {
        onSuccess: (data) => {
          // Show commit info if changes were made
          if (data.hasChanges && !autoCommit) {
            setClaudeError(
              `Claude made changes. Use "Respond & Commit" to auto-commit, or commit manually.`,
            );
          } else if (data.commit?.success) {
            setClaudeError(`Changes committed: ${data.commit.commitHash?.slice(0, 7)}`);
          }
        },
        onError: (e) => {
          setClaudeError(e.message);
        },
        onSettled: () => {
          setClaudeResponding(null);
        },
      },
    );
  };

  const addReply = (conversationUuid: string, triggerClaude: boolean = true) => {
    if (!replyContent.trim()) return;

    addReplyMutation.mutate(
      { conversationUuid, content: replyContent },
      {
        onSuccess: () => {
          setReplyContent('');
          // Auto-trigger Claude to respond
          if (triggerClaude) {
            respondWithClaude(conversationUuid, false);
          }
        },
      },
    );
  };

  const toggleConversation = (uuid: string) => {
    setExpandedConversation((prev) => (prev === uuid ? null : uuid));
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
          <ConversationsHeader
            repoPath={repoPath}
            filter={filter}
            conversationsCount={conversations.length}
            onChangeRepo={() => {
              setRepoPath('');
              setInputPath('');
            }}
            onFilterChange={setFilter}
          />

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
            <ConversationGroups
              groupedConversations={groupedConversations}
              repoPath={repoPath}
              expandedConversation={expandedConversation}
              conversationMessages={conversationMessages}
              replyContent={replyContent}
              claudeResponding={claudeResponding}
              claudeError={claudeError}
              onToggleConversation={toggleConversation}
              onReplyChange={setReplyContent}
              onAddReply={addReply}
              onRespondWithClaude={respondWithClaude}
              onResolveConversation={resolveConversation}
              onDeleteConversation={deleteConversation}
            />
          )}
        </div>
      )}
    </main>
  );
}
