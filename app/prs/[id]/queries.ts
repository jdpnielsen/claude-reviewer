import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

import type { CommentReply, CommentWithReplies, PRData } from './types';
import { apiClient, buildQuery } from '@/lib/api-client';
import { AuthorKind, CommentResolutionMode, CommentTargetType, ReviewAction } from '@/lib/enum';
import type { LineType, PullRequestStatus } from '@/lib/enum';

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
// comments/status/commits are refreshed in the background, so a large diff
// never gets silently re-fetched/re-rendered just because the polling tick
// fired.
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
  content: string;
  commitSha: string | null;
  targetType?: CommentTargetType;
  // Required for a line comment; unused (sentinel values applied server-side)
  // for a commit_message comment, which has no file/line to anchor to.
  filePath?: string;
  lineNumber?: number;
  endLineNumber?: number;
  lineType?: LineType;
  // Old-side range, when the comment also spans an adjacent deleted-line
  // block - see CommentingAt.pairedStartLine/pairedEndLine.
  pairedLineNumber?: number;
  pairedEndLineNumber?: number;
  resolutionMode?: CommentResolutionMode;
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
          file_path: params.filePath ?? '',
          line_number: params.lineNumber ?? 0,
          end_line_number: params.endLineNumber ?? 0,
          commit_sha: params.commitSha,
          target_type: params.targetType ?? CommentTargetType.Line,
          line_type: params.lineType ?? 'new',
          content: params.content,
          resolved: false,
          resolution_mode: params.resolutionMode ?? CommentResolutionMode.Fix,
          // The web UI's own comment form only ever creates a line or
          // commit-message comment - a review-summary comment is only ever
          // created server-side, from submitReview.
          review_action: null,
          created_at: new Date().toISOString(),
          paired_line_number: params.pairedLineNumber ?? null,
          paired_end_line_number: params.pairedEndLineNumber ?? null,
          // Only ever populated server-side, from the actual blob the
          // comment was made against - never known at optimistic-insert time.
          anchor_content: null,
          anchor_context_before: null,
          anchor_context_after: null,
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

// Open/close a PR from the web UI (close -> 'closed', reopen -> 'pending').
// Invalidates the polled query since that's the source of `pr.status` in the
// merged page data (see usePRCommentsPollQuery and page.tsx's `data`).
export function useSetPRStatusMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (status: PullRequestStatus) => apiClient.patch(`/api/prs/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: prCommentsQueryKey(id) }),
    onError: () => alert('Error updating PR status'),
  });
}

// Permanently remove the PR and all its review data (web-UI equivalent of the
// CLI's `delete`). Runs no git server-side, so this works even when the PR's
// checkout is gone - which is the case it mainly exists for, since such a PR
// can no longer be synced or merged and would otherwise be stuck in the list
// forever. The caller navigates away on success; the PR's own queries are left
// alone deliberately (refetching a deleted PR would just 404).
export function useDeletePRMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.delete(`/api/prs/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['prs'] }),
    onError: (error) => alert(`Delete failed: ${error.message}`),
  });
}

interface ReviewedFileParams {
  filePath: string;
  commitSha: string | null;
}

// Reviewed marks live on the same polled query as comments/commits (see
// usePRCommentsPollQuery) - a plain invalidate-and-refetch is enough here
// since marking/unmarking isn't performance-sensitive the way comment
// mutations are, and the server, not the client, is what computes a mark's
// `current` status anyway (see the reviewed-files API route).
export function useMarkFileReviewedMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: ReviewedFileParams) =>
      apiClient.post(`/api/prs/${id}/reviewed`, params),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: prCommentsQueryKey(id) }),
    onError: () => alert('Error marking file reviewed'),
  });
}

export function useUnmarkFileReviewedMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: ReviewedFileParams) =>
      apiClient.delete(
        `/api/prs/${id}/reviewed${buildQuery({ file: params.filePath, commit: params.commitSha })}`,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: prCommentsQueryKey(id) }),
    onError: () => alert('Error unmarking file reviewed'),
  });
}

export function useMarkCommitReviewedMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commitSha: string) =>
      apiClient.post(`/api/prs/${id}/reviewed/commit`, { commitSha }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: prCommentsQueryKey(id) }),
    onError: () => alert('Error marking commit reviewed'),
  });
}

export function useUnmarkCommitReviewedMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commitSha: string) =>
      apiClient.delete(`/api/prs/${id}/reviewed/commit${buildQuery({ commit: commitSha })}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: prCommentsQueryKey(id) }),
    onError: () => alert('Error unmarking commit reviewed'),
  });
}

// Re-pull the branch diff (web-UI equivalent of the CLI's `update`). This
// rewrites the diff/files/commits *and* resets status to pending, so it
// invalidates both the main PR query (all commit-filtered variants, matched by
// the `['pr', id]` key prefix) and the polled comments/status query.
export function useSyncPRMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post(`/api/prs/${id}/sync`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pr', id] });
      queryClient.invalidateQueries({ queryKey: prCommentsQueryKey(id) });
    },
    onError: (error) => alert(`Sync failed: ${error.message}`),
  });
}
