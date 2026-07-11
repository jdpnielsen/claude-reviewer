import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Conversation, ConversationWithMessages } from '@/app/browse/conversations/types';
import { apiClient, buildQuery } from '@/lib/api-client';
import { ConversationStatus } from '@/lib/enum';
import { browseFileQueryKey } from '@/lib/queries/browse';

// Shared by both /browse and /browse/conversations - both talk to the same
// /api/browse/conversations* and /api/claude endpoints, just with different
// slices of the data and different post-mutation invalidation needs.

export const conversationsQueryKey = (repo: string, status: ConversationStatus | 'all') =>
  ['browse-conversations', repo, status] as const;

interface RawConversationsResponse {
  conversations: (ConversationWithMessages & { message_count?: number })[];
}

export function useConversationsQuery(repo: string, status: ConversationStatus | 'all') {
  return useQuery({
    queryKey: conversationsQueryKey(repo, status),
    queryFn: async () => {
      const data = await apiClient.get<RawConversationsResponse>(
        `/api/browse/conversations${buildQuery({ repo, status: status === 'all' ? undefined : status })}`,
      );
      // Transform nested API response to flat conversation objects.
      const conversations: Conversation[] = data.conversations.map((item) => ({
        ...item.conversation,
        message_count: item.message_count || item.messages?.length || 0,
        latest_message: item.messages?.length > 0 ? item.messages[item.messages.length - 1] : null,
      }));
      return { conversations };
    },
    enabled: !!repo,
    refetchInterval: 2000,
  });
}

export const conversationMessagesQueryKey = (uuid: string) =>
  ['browse-conversation-messages', uuid] as const;

// Single conversation's messages - used by /browse/conversations, polled
// only while that conversation is expanded (enabled: !!uuid).
export function useConversationMessagesQuery(uuid: string | null) {
  return useQuery({
    queryKey: conversationMessagesQueryKey(uuid ?? ''),
    queryFn: () =>
      apiClient.get<ConversationWithMessages>(`/api/browse/conversations/${uuid}/messages`),
    enabled: !!uuid,
    refetchInterval: 2000,
  });
}

// Many conversations' messages at once - used by /browse, which polls every
// conversation attached to the currently viewed file in parallel.
export function useConversationMessagesQueries(uuids: string[]) {
  return useQueries({
    queries: uuids.map((uuid) => ({
      queryKey: conversationMessagesQueryKey(uuid),
      queryFn: () =>
        apiClient.get<ConversationWithMessages>(`/api/browse/conversations/${uuid}/messages`),
      refetchInterval: 2000,
    })),
  });
}

// /browse only: starts a new conversation anchored to a file/line.
export function useAddCommentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { repo: string; filePath: string; lineNumber: number; content: string }) =>
      apiClient.post<{ uuid: string; success: boolean }>('/api/browse/conversations', params),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: browseFileQueryKey(variables.repo, variables.filePath),
      });
    },
  });
}

// Shared: both pages just refresh that conversation's own message thread
// after posting a reply - neither reloads the file or list on this action.
export function useAddReplyMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ conversationUuid, content }: { conversationUuid: string; content: string }) =>
      apiClient.post<{ uuid: string; success: boolean }>(
        `/api/browse/conversations/${conversationUuid}/messages`,
        { content },
      ),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: conversationMessagesQueryKey(variables.conversationUuid),
      });
    },
  });
}

// Shared: /browse reads the resolved status from its file query, /browse/
// conversations reads it from its list query - invalidate both prefixes
// unconditionally rather than threading page-specific context through here.
// Whichever page isn't mounted just has no matching active query, so the
// extra invalidation is a no-op there.
export function useResolveConversationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (uuid: string) =>
      apiClient.patch('/api/browse/conversations', { uuid, status: ConversationStatus.Resolved }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['browse-file'] });
      queryClient.invalidateQueries({ queryKey: ['browse-conversations'] });
    },
  });
}

// /browse/conversations only.
export function useDeleteConversationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (uuid: string) =>
      apiClient.delete(`/api/browse/conversations${buildQuery({ uuid })}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['browse-conversations'] });
    },
  });
}

// /browse only: fire-and-forget - the API responds with `{ status:
// 'processing' }` immediately and Claude's eventual reply is picked up by
// the polling message queries, so there's nothing to invalidate on success.
export function useRespondWithClaudeAsyncMutation() {
  return useMutation({
    mutationFn: (conversationUuid: string) =>
      apiClient.post<{ status: string; conversationUuid: string }>('/api/claude', {
        action: 'respond',
        conversationUuid,
        allowEdits: true,
        autoCommit: false,
        push: false,
        async: true,
      }),
  });
}

export interface RespondWithClaudeResult {
  response: string;
  messageUuid: number;
  hasChanges: boolean;
  commit: { success: boolean; commitHash?: string; error?: string } | null;
}

// /browse/conversations only: waits for Claude's full reply so the caller
// can report hasChanges/commit info, then refreshes that conversation's
// messages so the reply shows immediately instead of on the next poll tick.
export function useRespondWithClaudeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationUuid,
      autoCommit = false,
    }: {
      conversationUuid: string;
      autoCommit?: boolean;
    }) =>
      apiClient.post<RespondWithClaudeResult>('/api/claude', {
        action: 'respond',
        conversationUuid,
        allowEdits: true,
        autoCommit,
        push: false,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: conversationMessagesQueryKey(variables.conversationUuid),
      });
    },
  });
}
