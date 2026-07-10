'use client';

import { MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';

import type { Conversation, ConversationMessage, ConversationWithMessages } from './types';
import { useConfirm } from '@/components/ConfirmDialog';
import ConversationGroups from '@/components/browse/ConversationGroups';
import ConversationsHeader from '@/components/browse/ConversationsHeader';
import RepoPathPicker from '@/components/browse/RepoPathPicker';
import { ConversationStatus } from '@/lib/enum';
import { getRecentRepos, saveRecentRepo } from '@/lib/recent-repos';

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
              setConversations([]);
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
