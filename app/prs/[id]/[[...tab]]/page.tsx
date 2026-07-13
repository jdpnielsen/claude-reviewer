'use client';

import { Loader2 } from 'lucide-react';
import { useQueryState } from 'nuqs';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useEffect, use } from 'react';

import {
  useAddCommentMutation,
  useAddReplyMutation,
  useDeleteCommentMutation,
  useEditCommentMutation,
  usePRCommentsPollQuery,
  usePRQuery,
  useRequestAIReviewMutation,
  useResolveCommentMutation,
  useSubmitReviewMutation,
} from '@/app/prs/[id]/queries';
import type { CommentingAt, EditingComment, LastClickedLine, PRData } from '@/app/prs/[id]/types';
import { statusConfig } from '@/app/prs/[id]/utils';
import { useConfirm } from '@/components/ConfirmDialog';
import CommitSelector from '@/components/pr/CommitSelector';
import ConversationTab from '@/components/pr/ConversationTab';
import FileDiffCard from '@/components/pr/FileDiffCard';
import PRHeader from '@/components/pr/PRHeader';
import PRSidebar from '@/components/pr/PRSidebar';
import PRTabs, { type PRViewTab } from '@/components/pr/PRTabs';
import ReviewPanel from '@/components/pr/ReviewPanel';
import { apiClient } from '@/lib/api-client';
import { ReviewAction } from '@/lib/enum';
import { useAuthorsQuery } from '@/lib/queries/authors';

export default function PRPage({
  params,
}: {
  params: Promise<{ id: string; tab?: string[] }>;
}) {
  const { id, tab } = use(params);
  const activeTab: PRViewTab = tab?.[0] === 'conversation' ? 'conversation' : 'files';
  const router = useRouter();
  const confirm = useConfirm();
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  // Files the user has explicitly collapsed - always wins over the
  // comment-based or file-count-based defaults (see isFileExpanded below).
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [selectedCommit, setSelectedCommit] = useQueryState('commit');
  const [commentingAt, setCommentingAt] = useState<CommentingAt | null>(null);
  const [lastClickedLine, setLastClickedLine] = useState<LastClickedLine | null>(null);
  const [newComment, setNewComment] = useState('');
  const [editingComment, setEditingComment] = useState<EditingComment | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [reviewSummary, setReviewSummary] = useState('');
  const [previewMode, setPreviewMode] = useState<Set<string>>(new Set());
  // Track expanded context: key is "filePath:hunkIndex:direction", value is array of lines
  const [expandedContext, setExpandedContext] = useState<Map<string, string[]>>(new Map());
  const [loadingContext, setLoadingContext] = useState<Set<string>>(new Set());
  // Track which files show all lines (for large diffs)
  const [showAllLines, setShowAllLines] = useState<Set<string>>(new Set());
  // Track collapsed folders in sidebar
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  // Set by jumpToFile (from the Conversation tab) so the scroll can happen
  // once the Files tab has actually mounted - see the effect below.
  const [pendingScrollTarget, setPendingScrollTarget] = useState<string | null>(null);

  // Switching `selectedCommit` changes this query's key; `keepPreviousData`
  // keeps the sidebar/diff pane mounted with the previous commit's data
  // (isFetching: true) instead of unmounting while the new one loads - this
  // is what the old manual latestRequestRef race-guard used to do by hand.
  const prQuery = usePRQuery(id, selectedCommit);
  // Deliberately a separate, always-polled query - see queries.ts for why.
  const commentsQuery = usePRCommentsPollQuery(id);
  const { data: authorsData } = useAuthorsQuery();
  const defaultAuthorName = authorsData?.authors.find((a) => a.isDefaultHuman)?.name ?? 'reviewer';

  const addCommentMutation = useAddCommentMutation(id);
  const editCommentMutation = useEditCommentMutation(id);
  const addReplyMutation = useAddReplyMutation(id);
  const resolveCommentMutation = useResolveCommentMutation(id);
  const deleteCommentMutation = useDeleteCommentMutation(id);
  const submitReviewMutation = useSubmitReviewMutation(id);
  const requestAIReviewMutation = useRequestAIReviewMutation(id);

  const data: PRData | undefined = prQuery.data && {
    ...prQuery.data,
    comments: commentsQuery.data?.comments ?? prQuery.data.comments,
    pr: { ...prQuery.data.pr, status: commentsQuery.data?.pr.status ?? prQuery.data.pr.status },
  };

  // For large PRs (>10 files), only expand first 3 files by default -
  // files with comments are always expanded regardless (see isFileExpanded).
  // For smaller PRs, expand all. Re-runs whenever a genuinely new file list
  // arrives (initial load, or switching commits) - `prQuery.data` keeps its
  // previous reference while a refetch is in flight (`keepPreviousData`), so
  // this doesn't fire on every render, only on an actual new response. Manual
  // collapses are reset here too, since a new file list means a fresh view.
  useEffect(() => {
    if (!prQuery.data) return;
    const files = prQuery.data.files;
    if (files.length > 10) {
      setExpandedFiles(new Set(files.slice(0, 3).map((f) => f.path)));
    } else {
      setExpandedFiles(new Set(files.map((f) => f.path)));
    }
    setCollapsedFiles(new Set());
    // Only re-run when the file list itself changes identity, not on every
    // render - see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prQuery.data]);

  const fetchContext = async (
    filePath: string,
    startLine: number,
    endLine: number,
    key: string,
  ) => {
    if (loadingContext.has(key)) return;

    setLoadingContext((prev) => new Set(prev).add(key));
    try {
      const contextData = await apiClient.get<{ lines: string[] }>(
        `/api/prs/${id}/context?file=${encodeURIComponent(filePath)}&start=${startLine}&end=${endLine}`,
      );
      setExpandedContext((prev) => {
        const next = new Map(prev);
        const existing = next.get(key) || [];
        next.set(key, [...existing, ...contextData.lines]);
        return next;
      });
    } catch (e) {
      console.error('Failed to fetch context:', e);
    } finally {
      setLoadingContext((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const togglePreview = (path: string) => {
    const newPreview = new Set(previewMode);
    if (newPreview.has(path)) {
      newPreview.delete(path);
    } else {
      newPreview.add(path);
    }
    setPreviewMode(newPreview);
  };

  const selectCommit = (sha: string | null) => {
    setSelectedCommit(sha);
  };

  const toggleFile = (path: string) => {
    if (isFileExpanded(path)) {
      setCollapsedFiles((prev) => new Set(prev).add(path));
      setExpandedFiles((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } else {
      setExpandedFiles((prev) => new Set(prev).add(path));
      setCollapsedFiles((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  };

  const expandAll = () => {
    if (!data) return;
    setExpandedFiles(new Set(data.files.map((f) => f.path)));
    setCollapsedFiles(new Set());
  };

  const collapseAll = () => {
    if (!data) return;
    setExpandedFiles(new Set());
    setCollapsedFiles(new Set(data.files.map((f) => f.path)));
  };

  const scrollToDiff = (path: string) => {
    const element = document.getElementById(`file-${path.replace(/[^a-zA-Z0-9]/g, '-')}`);
    const mainContainer = document.querySelector('.pr-main');
    if (element && mainContainer) {
      // Scroll within the main container, not the whole page
      const containerRect = mainContainer.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const scrollTop = mainContainer.scrollTop + (elementRect.top - containerRect.top) - 20;
      mainContainer.scrollTop = scrollTop;
    }
  };

  // Used by the Conversation tab's "View in Files" action - selects the
  // commit the comment was made against (so the diff matches what the
  // commenter actually saw), force-expands the target file (explicit
  // override, same as toggleFile's expand branch), and defers the scroll
  // until that commit's diff has finished loading.
  //
  // This is the one place that builds a URL and navigates directly instead
  // of going through the per-field abstractions (nuqs setter, tab Links)
  // used everywhere else: it needs to change both the path (back to Files)
  // and the commit query in one shot, and nuqs's setter alone would only
  // touch the query while leaving us on the Conversation path.
  const jumpToFile = (filePath: string, commitSha: string | null) => {
    setExpandedFiles((prev) => new Set(prev).add(filePath));
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      next.delete(filePath);
      return next;
    });
    setPendingScrollTarget(filePath);
    router.replace(`/prs/${id}${commitSha ? `?commit=${encodeURIComponent(commitSha)}` : ''}`);
  };

  useEffect(() => {
    // Wait for a commit switch triggered by jumpToFile to actually land -
    // otherwise this can fire while the previous commit's files are still
    // rendered (keepPreviousData) and scroll to nothing, or the wrong file.
    if (activeTab !== 'files' || !pendingScrollTarget || prQuery.isFetching) return;
    scrollToDiff(pendingScrollTarget);
    setPendingScrollTarget(null);
    // Only re-run when the tab, pending target, or fetch state changes -
    // scrollToDiff reads the DOM directly and isn't itself reactive state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, pendingScrollTarget, prQuery.isFetching]);

  const addComment = () => {
    if (!commentingAt || !newComment.trim() || !data) return;
    addCommentMutation.mutate({
      filePath: commentingAt.file,
      lineNumber: commentingAt.startLine,
      endLineNumber: commentingAt.endLine,
      lineType: commentingAt.lineType,
      commitSha: selectedCommit,
      content: newComment,
    });
    setNewComment('');
    setCommentingAt(null);
    setLastClickedLine(null);
  };

  const editComment = () => {
    if (!editingComment || !editingComment.content.trim() || !data) return;
    editCommentMutation.mutate({ uuid: editingComment.uuid, content: editingComment.content });
    setEditingComment(null);
  };

  const addReply = (commentUuid: string) => {
    if (!replyContent.trim() || !data) return;
    addReplyMutation.mutate({ commentUuid, content: replyContent, authorName: defaultAuthorName });
    setReplyContent('');
    setReplyingTo(null);
  };

  const resolveComment = (commentUuid: string, resolved: boolean) => {
    if (!data) return;
    resolveCommentMutation.mutate({ uuid: commentUuid, resolved });
  };

  const deleteComment = async (commentUuid: string, replyCount: number) => {
    if (!data) return;

    const message =
      replyCount > 0
        ? `Delete this comment and its ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}?`
        : 'Delete this comment?';
    if (!(await confirm(message, { danger: true }))) return;

    deleteCommentMutation.mutate(commentUuid);
  };

  const submitReview = (
    action: typeof ReviewAction.Approve | typeof ReviewAction.RequestChanges,
  ) => {
    submitReviewMutation.mutate(
      { action, summary: reviewSummary },
      { onSuccess: () => setReviewSummary('') },
    );
  };

  const requestAIReview = () => {
    requestAIReviewMutation.mutate();
  };

  // Get comments for a specific file
  const getFileComments = (filePath: string) => {
    if (!data) return [];
    return data.comments.filter(
      (c) => c.comment.file_path === filePath && c.comment.commit_sha === selectedCommit,
    );
  };

  // A file with comments is always shown expanded, so reviewers never miss
  // existing discussion - unless the user has explicitly collapsed it, which
  // always wins. Absent either of those, fall back to the file-count default.
  const isFileExpanded = (filePath: string) => {
    if (collapsedFiles.has(filePath)) return false;
    if (expandedFiles.has(filePath)) return true;
    return getFileComments(filePath).length > 0;
  };

  if (prQuery.isPending) {
    return (
      <main className="container">
        <div className="loading">Loading PR...</div>
      </main>
    );
  }

  if (prQuery.error || !data) {
    return (
      <main className="container">
        <div className="error">{prQuery.error?.message || 'PR not found'}</div>
        <Link href="/">Back to list</Link>
      </main>
    );
  }

  const { pr, diff, files, comments } = data;
  const config = statusConfig[pr.status];
  const unresolvedCount = comments.filter((c) => !c.comment.resolved).length;
  const effectiveExpandedFiles = new Set(
    files.filter((f) => isFileExpanded(f.path)).map((f) => f.path),
  );

  // Preserved across tab links so switching tabs and back doesn't lose the
  // commit selection, even though the Conversation tab itself ignores it.
  const commitQuery = selectedCommit ? `?commit=${encodeURIComponent(selectedCommit)}` : '';
  const filesHref = `/prs/${id}${commitQuery}`;
  const conversationHref = `/prs/${id}/conversation${commitQuery}`;

  return (
    <main className="container pr-detail">
      <PRHeader
        pr={pr}
        config={config}
        requestingAI={requestAIReviewMutation.isPending}
        showFileControls={activeTab === 'files'}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        onRequestAIReview={requestAIReview}
      />

      <div className="pr-tabbar">
        <div className="pr-tabbar-left">
          <PRTabs
            activeTab={activeTab}
            filesHref={filesHref}
            conversationHref={conversationHref}
            filesCount={files.length}
            unresolvedCount={unresolvedCount}
          />
          {activeTab === 'files' && (
            <CommitSelector
              commits={data.commits}
              selectedCommit={selectedCommit}
              selectCommit={selectCommit}
            />
          )}
        </div>
        <ReviewPanel
          status={pr.status}
          reviewSummary={reviewSummary}
          setReviewSummary={setReviewSummary}
          submitting={submitReviewMutation.isPending}
          submitReview={submitReview}
        />
      </div>

      {/* Layout: Sidebar + Main */}
      <div className={`pr-layout ${activeTab === 'conversation' ? 'single-column' : ''}`}>
        {activeTab === 'files' && (
          <PRSidebar
            files={files}
            expandedFiles={effectiveExpandedFiles}
            collapsedFolders={collapsedFolders}
            setCollapsedFolders={setCollapsedFolders}
            toggleFile={toggleFile}
            scrollToDiff={scrollToDiff}
          />
        )}

        {/* Main Diff View */}
        <div className="pr-main">
          {activeTab === 'files' ? (
            <>
              {prQuery.isFetching && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.75rem 1rem',
                    background: '#161b22',
                    borderBottom: '1px solid #30363d',
                    color: '#8b949e',
                    fontSize: '0.8rem',
                  }}
                >
                  <Loader2 size={14} className="animate-spin" />
                  Loading commit diff...
                </div>
              )}
              {files.map((file) => (
                <FileDiffCard
                  key={file.path}
                  file={file}
                  diff={diff}
                  fileComments={getFileComments(file.path)}
                  isExpanded={effectiveExpandedFiles.has(file.path)}
                  toggleFile={toggleFile}
                  isPreview={previewMode.has(file.path)}
                  togglePreview={togglePreview}
                  showAllLines={showAllLines}
                  setShowAllLines={setShowAllLines}
                  expandedContext={expandedContext}
                  loadingContext={loadingContext}
                  fetchContext={fetchContext}
                  commentingAt={commentingAt}
                  setCommentingAt={setCommentingAt}
                  lastClickedLine={lastClickedLine}
                  setLastClickedLine={setLastClickedLine}
                  newComment={newComment}
                  setNewComment={setNewComment}
                  addComment={addComment}
                  editingComment={editingComment}
                  setEditingComment={setEditingComment}
                  editComment={editComment}
                  replyingTo={replyingTo}
                  setReplyingTo={setReplyingTo}
                  replyContent={replyContent}
                  setReplyContent={setReplyContent}
                  addReply={addReply}
                  resolveComment={resolveComment}
                  deleteComment={deleteComment}
                />
              ))}
            </>
          ) : (
            // PR-wide, deliberately not filtered by selectedCommit - the
            // Conversation tab always shows every thread regardless of which
            // commit is selected in the sidebar (see getFileComments above,
            // which the Files tab uses instead).
            <ConversationTab
              comments={comments}
              commits={data.commits}
              onJumpToFile={jumpToFile}
              editingComment={editingComment}
              setEditingComment={setEditingComment}
              editComment={editComment}
              replyingTo={replyingTo}
              setReplyingTo={setReplyingTo}
              replyContent={replyContent}
              setReplyContent={setReplyContent}
              addReply={addReply}
              resolveComment={resolveComment}
              deleteComment={deleteComment}
            />
          )}
        </div>
      </div>
    </main>
  );
}
