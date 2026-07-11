import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

import type { CommentReply, CommentWithReplies, PRData } from './types';
import { apiClient, buildQuery } from '@/lib/api-client';
import { AuthorKind, ReviewAction } from '@/lib/enum';
import type { LineType } from '@/lib/enum';

export const prQueryKey = (id: string, commit: string | null) => ['pr', id, { commit }] as const;
export const prCommentsQueryKey = (id: string) => ['pr-comments', id] as const;

// The main PR data (diff/files/commits/pr metadata) for a given commit filter.
// `placeholderData: keepPreviousData` is what replaces the old manual
// `latestRequestRef` race-guard: switching `commit` changes the query key, so
// React Query tracks each commit's request/response independently rather
// than one shared "latest request wins" ref, and keeps showing the previous
// commit's data (with `isFetching: true`) while the new one loads instead of
// unmounting the sidebar/diff pane.
export function usePRQuery(id: string, commit: string | null) {
  return useQuery({
    queryKey: prQueryKey(id, commit),
    queryFn: () => apiClient.get<PRData>(`/api/prs/${id}${buildQuery({ commit })}`),
    placeholderData: keepPreviousData,
  });
}

// Deliberately separate from usePRQuery and polled every 5s on its own: only
// comments/status are refreshed in the background, so a large diff never
// gets silently re-fetched/re-rendered just because the polling tick fired.
export function usePRCommentsPollQuery(id: string) {
  return useQuery({
    queryKey: prCommentsQueryKey(id),
    queryFn: () => apiClient.get<PRData>(`/api/prs/${id}`),
    refetchInterval: 5000,
  });
}

function updateComments(
  queryClient: QueryClient,
  id: string,
  updater: (comments: CommentWithReplies[]) => CommentWithReplies[],
) {
  queryClient.setQueryData<PRData>(prCommentsQueryKey(id), (old) =>
    old ? { ...old, comments: updater(old.comments) } : old,
  );
}

interface AddCommentParams {
  filePath: string;
  lineNumber: number;
  endLineNumber: number;
  lineType: LineType;
  commitSha: string | null;
  content: string;
}

export function useAddCommentMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: AddCommentParams) =>
      apiClient.post<{ uuid: string }>(`/api/prs/${id}/comments`, params),
    onMutate: (params) => {
      const tempUuid = `temp-${Date.now()}`;
      const newCommentObj: CommentWithReplies = {
        comment: {
          id: Date.now(),
          uuid: tempUuid,
          file_path: params.filePath,
          line_number: params.lineNumber,
          end_line_number: params.endLineNumber,
          commit_sha: params.commitSha,
          line_type: params.lineType,
          content: params.content,
          resolved: false,
          created_at: new Date().toISOString(),
        },
        replies: [],
      };
      updateComments(queryClient, id, (comments) => [...comments, newCommentObj]);
      return { tempUuid };
    },
    onSuccess: (result, _params, context) => {
      updateComments(queryClient, id, (comments) =>
        comments.map((c) =>
          c.comment.uuid === context.tempUuid
            ? { ...c, comment: { ...c.comment, uuid: result.uuid } }
            : c,
        ),
      );
    },
    onError: (_err, _params, context) => {
      alert('Error adding comment');
      updateComments(queryClient, id, (comments) =>
        comments.filter((c) => c.comment.uuid !== context?.tempUuid),
      );
    },
  });
}

interface EditCommentParams {
  uuid: string;
  content: string;
}

export function useEditCommentMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: EditCommentParams) =>
      apiClient.patch(`/api/prs/${id}/comments`, {
        commentUuid: params.uuid,
        content: params.content,
      }),
    onMutate: (params) => {
      let original: CommentWithReplies | undefined;
      updateComments(queryClient, id, (comments) =>
        comments.map((c) => {
          if (c.comment.uuid !== params.uuid) return c;
          original = c;
          return { ...c, comment: { ...c.comment, content: params.content } };
        }),
      );
      return { original };
    },
    onError: (_err, params, context) => {
      alert('Error updating comment');
      if (context?.original) {
        const original = context.original;
        updateComments(queryClient, id, (comments) =>
          comments.map((c) => (c.comment.uuid === params.uuid ? original : c)),
        );
      }
    },
  });
}

interface AddReplyParams {
  commentUuid: string;
  content: string;
  authorName: string;
}

export function useAddReplyMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: AddReplyParams) =>
      apiClient.post<{ uuid: string }>(`/api/prs/${id}/comments`, {
        commentUuid: params.commentUuid,
        content: params.content,
      }),
    onMutate: (params) => {
      const tempReply: CommentReply = {
        id: Date.now(),
        uuid: `temp-${Date.now()}`,
        author: params.authorName,
        author_kind: AuthorKind.Human,
        content: params.content,
        created_at: new Date().toISOString(),
      };
      updateComments(queryClient, id, (comments) =>
        comments.map((c) =>
          c.comment.uuid === params.commentUuid ? { ...c, replies: [...c.replies, tempReply] } : c,
        ),
      );
      return { tempUuid: tempReply.uuid };
    },
    onSuccess: (result, params, context) => {
      updateComments(queryClient, id, (comments) =>
        comments.map((c) =>
          c.comment.uuid === params.commentUuid
            ? {
                ...c,
                replies: c.replies.map((r) =>
                  r.uuid === context.tempUuid ? { ...r, uuid: result.uuid } : r,
                ),
              }
            : c,
        ),
      );
    },
    onError: (_err, params, context) => {
      alert('Error adding reply');
      updateComments(queryClient, id, (comments) =>
        comments.map((c) =>
          c.comment.uuid === params.commentUuid
            ? { ...c, replies: c.replies.filter((r) => r.uuid !== context?.tempUuid) }
            : c,
        ),
      );
    },
  });
}

interface ResolveCommentParams {
  uuid: string;
  resolved: boolean;
}

export function useResolveCommentMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: ResolveCommentParams) =>
      apiClient.patch(`/api/prs/${id}/comments`, {
        commentUuid: params.uuid,
        resolved: params.resolved,
      }),
    onMutate: (params) => {
      updateComments(queryClient, id, (comments) =>
        comments.map((c) =>
          c.comment.uuid === params.uuid
            ? { ...c, comment: { ...c.comment, resolved: params.resolved } }
            : c,
        ),
      );
    },
    onError: (_err, params) => {
      alert('Error updating comment');
      updateComments(queryClient, id, (comments) =>
        comments.map((c) =>
          c.comment.uuid === params.uuid
            ? { ...c, comment: { ...c.comment, resolved: !params.resolved } }
            : c,
        ),
      );
    },
  });
}

export function useDeleteCommentMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commentUuid: string) =>
      apiClient.delete(`/api/prs/${id}/comments${buildQuery({ uuid: commentUuid })}`),
    onMutate: (commentUuid) => {
      let original: CommentWithReplies | undefined;
      updateComments(queryClient, id, (comments) =>
        comments.filter((c) => {
          if (c.comment.uuid !== commentUuid) return true;
          original = c;
          return false;
        }),
      );
      return { original };
    },
    onError: (_err, _commentUuid, context) => {
      alert('Error deleting comment');
      if (context?.original) {
        const original = context.original;
        updateComments(queryClient, id, (comments) => [...comments, original]);
      }
    },
  });
}

export function useSubmitReviewMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      action: typeof ReviewAction.Approve | typeof ReviewAction.RequestChanges;
      summary: string;
    }) => apiClient.post(`/api/prs/${id}/review`, params),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: prCommentsQueryKey(id) }),
    onError: () => alert('Error submitting review'),
  });
}

export function useRequestAIReviewMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post(`/api/prs/${id}/ai-review`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: prCommentsQueryKey(id) }),
    onError: (error) => alert(`AI Review failed: ${error.message}`),
  });
}
