'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryState } from 'nuqs';
import { useState, useEffect, use } from 'react';

import {
  useAddCommentMutation,
  useAddReplyMutation,
  useDeleteCommentMutation,
  useDeletePRMutation,
  useEditCommentMutation,
  usePRCommentsPollQuery,
  usePRQuery,
  useRequestAIReviewMutation,
  useResolveCommentMutation,
  useSetPRStatusMutation,
  useSubmitReviewMutation,
  useSyncPRMutation,
} from '@/app/prs/[id]/queries';
import type { CommentingAt, EditingComment, LastClickedLine, PRData } from '@/app/prs/[id]/types';
import { shouldCollapseByDefault, statusConfig } from '@/app/prs/[id]/utils';
import { useConfirm } from '@/components/ConfirmDialog';
import CommitMessagePanel from '@/components/pr/CommitMessagePanel';
import CommitSelector from '@/components/pr/CommitSelector';
import ConversationTab from '@/components/pr/ConversationTab';
import FileDiffCard from '@/components/pr/FileDiffCard';
import FileViewControls from '@/components/pr/FileViewControls';
import PRHeader from '@/components/pr/PRHeader';
import PRSidebar from '@/components/pr/PRSidebar';
import PRTabs, { type PRViewTab } from '@/components/pr/PRTabs';
import ReviewPanel from '@/components/pr/ReviewPanel';
import { apiClient, ApiError } from '@/lib/api-client';
import { ChangeType, CommentTargetType, PullRequestStatus, ReviewAction } from '@/lib/enum';
import { useAuthorsQuery } from '@/lib/queries/authors';

export default function PRPage({ params }: { params: Promise<{ id: string; tab?: string[] }> }) {
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
  const [commentingOnCommitMessage, setCommentingOnCommitMessage] = useState(false);
  const [lastClickedLine, setLastClickedLine] = useState<LastClickedLine | null>(null);
  // True from mousedown on a gutter line until mouseup, however far away that
  // lands - suppresses the comment form while true so a drag-select doesn't
  // shift the page layout under the pointer mid-drag (commentingAt itself
  // still updates live, so the range highlight grows as you drag).
  const [isSelectingComment, setIsSelectingComment] = useState(false);
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
  // Set when a `?commit=` link turned out to be stale (rebase/amend/force-push
  // rewrote it) and couldn't be redirected to where it ended up - see the
  // effect below.
  const [commitNotice, setCommitNotice] = useState<string | null>(null);

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
  const setPRStatusMutation = useSetPRStatusMutation(id);
  const syncPRMutation = useSyncPRMutation(id);
  const deletePRMutation = useDeletePRMutation(id);

  const data: PRData | undefined = prQuery.data && {
    ...prQuery.data,
    comments: commentsQuery.data?.comments ?? prQuery.data.comments,
    commits: commentsQuery.data?.commits ?? prQuery.data.commits,
    pr: { ...prQuery.data.pr, status: commentsQuery.data?.pr.status ?? prQuery.data.pr.status },
  };

  // A `?commit=<sha>` link goes stale the moment a rebase/amend/force-push
  // changes that commit's SHA - the API 400s with 'Unknown commit for this
  // PR' rather than erroring the whole page. Detected here (not just inside
  // the effect below) so the render-gate further down can treat it as a
  // loading state rather than flashing the dead-end error screen for a tick
  // before the redirect below takes effect.
  const unknownCommitError =
    prQuery.error instanceof ApiError && prQuery.error.status === 400
      ? (prQuery.error.data as { relocatedTo?: string | null } | undefined)
      : undefined;
  const isUnknownCommitError = Boolean(unknownCommitError && 'relocatedTo' in unknownCommitError);

  // If relocateComments() has ever recorded where that SHA ended up, jump
  // straight there (URL self-heals, no error ever shown); otherwise fall
  // back to the cumulative view with a dismissible notice instead.
  useEffect(() => {
    if (!isUnknownCommitError) return;
    if (unknownCommitError?.relocatedTo) {
      setSelectedCommit(unknownCommitError.relocatedTo);
    } else {
      setCommitNotice('This commit is no longer part of the PR - showing the latest diff instead.');
      setSelectedCommit(null);
    }
    // Only re-run when a new failed fetch produces a new error object, not
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prQuery.error]);

  // Ends a gutter drag-select regardless of where the pointer is released -
  // over a diff line, off the edge of the page, wherever - so isSelectingComment
  // never gets stuck true if the mouseup happens somewhere untracked.
  useEffect(() => {
    const onMouseUp = () => setIsSelectingComment(false);
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, []);

  // Expand every file by default so reviewers see the whole change without
  // extra clicks, except: deleted files (their whole content is just the
  // removed lines, rarely worth reading in full), and files shouldCollapseByDefault
  // flags as noisy lockfiles or large enough to hit the per-file render cap
  // (see utils.ts). A file with comments is always expanded regardless (see
  // isFileExpanded), so a deleted/noisy/huge file that has review discussion
  // still opens. Re-runs whenever a genuinely new file list arrives (initial
  // load, or switching commits) - `prQuery.data` keeps its previous reference
  // while a refetch is in flight (`keepPreviousData`), so this doesn't fire on
  // every render, only on an actual new response. Manual collapses are reset
  // here too, since a new file list means a fresh view.
  useEffect(() => {
    if (!prQuery.data) return;
    const files = prQuery.data.files;
    const defaultOpen = files.filter(
      (f) => f.changeType !== ChangeType.Deleted && !shouldCollapseByDefault(f),
    );
    setExpandedFiles(new Set(defaultOpen.map((f) => f.path)));
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

  // Only one comment box (a diff line, or the commit message) is ever
  // drafting at a time - they share the same newComment state, so opening a
  // new one always starts from a blank slate and closes whichever else was
  // open, rather than leaking an unsubmitted draft (text, or a suggestion
  // fence) into an unrelated comment.
  const openLineComment = (target: CommentingAt) => {
    const isSameTarget =
      commentingAt?.file === target.file &&
      commentingAt?.startLine === target.startLine &&
      commentingAt?.endLine === target.endLine &&
      commentingAt?.lineType === target.lineType;
    if (!isSameTarget) {
      setCommentingOnCommitMessage(false);
      setNewComment('');
    }
    setCommentingAt(target);
  };

  const openCommitMessageComment = () => {
    setCommentingAt(null);
    setNewComment('');
    setCommentingOnCommitMessage(true);
  };

  // Switching commits changes which diff/commit message is even on screen -
  // an in-progress draft no longer refers to anything visible, and
  // submitting it would attach it to the wrong commit_sha.
  useEffect(() => {
    setCommentingAt(null);
    setCommentingOnCommitMessage(false);
    setNewComment('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCommit]);

  const addComment = () => {
    if (!commentingAt || !newComment.trim() || !data) return;
    addCommentMutation.mutate({
      filePath: commentingAt.file,
      lineNumber: commentingAt.startLine,
      endLineNumber: commentingAt.endLine,
      lineType: commentingAt.lineType,
      commitSha: selectedCommit,
      content: newComment,
      pairedLineNumber: commentingAt.pairedStartLine,
      pairedEndLineNumber: commentingAt.pairedEndLine,
    });
    setNewComment('');
    setCommentingAt(null);
    setLastClickedLine(null);
  };

  const addCommitMessageComment = () => {
    if (!selectedCommit || !newComment.trim() || !data) return;
    addCommentMutation.mutate({
      targetType: CommentTargetType.CommitMessage,
      commitSha: selectedCommit,
      content: newComment,
    });
    setNewComment('');
    setCommentingOnCommitMessage(false);
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
      (c) =>
        c.comment.target_type === CommentTargetType.Line &&
        c.comment.file_path === filePath &&
        c.comment.commit_sha === selectedCommit,
    );
  };

  // Get comments made on a specific commit's message (never cumulative -
  // a commit message comment always has a commit_sha).
  const getCommitMessageComments = (commitSha: string) => {
    if (!data) return [];
    return data.comments.filter(
      (c) =>
        c.comment.target_type === CommentTargetType.CommitMessage &&
        c.comment.commit_sha === commitSha,
    );
  };

  // Per-commit line comments for a file, visible only from the cumulative
  // ("All commits") view. getFileComments matches commit_sha === selectedCommit
  // exactly, so a comment made against one specific commit's diff never shows
  // up there at all - a line number from that commit's diff has no reliable
  // meaning in the cumulative diff, so these render as their own
  // commit-tagged list in FileDiffCard rather than inline at a (possibly
  // wrong) line. Empty once a specific commit is selected: every comment
  // relevant to that view already comes back from getFileComments.
  const getCommitSpecificFileComments = (filePath: string) => {
    if (!data || selectedCommit !== null) return [];
    return data.comments.filter(
      (c) =>
        c.comment.target_type === CommentTargetType.Line &&
        c.comment.file_path === filePath &&
        c.comment.commit_sha !== null,
    );
  };

  // A file with comments is always shown expanded, so reviewers never miss
  // existing discussion - unless the user has explicitly collapsed it, which
  // always wins. Absent either of those, fall back to the same per-file
  // default the data-load effect above seeds expandedFiles with. Computing
  // it here too (rather than relying solely on that effect's setState)
  // matters on the very first render after data arrives: expandedFiles is
  // still empty at that point since effects run after paint, and without
  // this fallback every file would flash "collapsed" for a frame before the
  // effect catches up.
  const isFileExpanded = (filePath: string) => {
    if (collapsedFiles.has(filePath)) return false;
    if (expandedFiles.has(filePath)) return true;
    if (getFileComments(filePath).length > 0) return true;
    if (getCommitSpecificFileComments(filePath).length > 0) return true;
    const file = data?.files.find((f) => f.path === filePath);
    return file ? file.changeType !== ChangeType.Deleted && !shouldCollapseByDefault(file) : false;
  };

  if (prQuery.isPending || isUnknownCommitError) {
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

  const closePR = async () => {
    const confirmed = await confirm(`Close PR "${pr.title}" without merging?`, { danger: true });
    if (confirmed) setPRStatusMutation.mutate(PullRequestStatus.Closed);
  };
  const reopenPR = () => setPRStatusMutation.mutate(PullRequestStatus.Pending);
  const syncPR = () => syncPRMutation.mutate();
  // Back to the list on success - this page's PR is gone, so staying here
  // would just refetch into a 404.
  const deletePR = async () => {
    const confirmed = await confirm(
      `Permanently delete PR "${pr.title}"? Its comments, replies and reviews go with it. This cannot be undone.`,
      { danger: true },
    );
    if (confirmed) deletePRMutation.mutate(undefined, { onSuccess: () => router.push('/') });
  };
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
      {commitNotice && (
        <div className="commit-notice">
          <span>{commitNotice}</span>
          <button
            type="button"
            className="commit-notice-dismiss"
            aria-label="Dismiss"
            onClick={() => setCommitNotice(null)}
          >
            &times;
          </button>
        </div>
      )}
      {!data.repoAvailable && (
        <div className="repo-gone-notice">
          <span>
            This PR&apos;s repository is no longer at <code>{pr.repo_path}</code> - most likely a
            worktree that has since been removed. Showing the last stored diff; syncing, per-commit
            views and AI review need the checkout back. Use <strong>Delete</strong> to clear the PR
            out.
          </span>
        </div>
      )}
      <PRHeader
        pr={pr}
        config={config}
        requestingAI={requestAIReviewMutation.isPending}
        statusChanging={setPRStatusMutation.isPending}
        syncing={syncPRMutation.isPending}
        deleting={deletePRMutation.isPending}
        repoAvailable={data.repoAvailable}
        onRequestAIReview={requestAIReview}
        onClose={closePR}
        onReopen={reopenPR}
        onSync={syncPR}
        onDelete={deletePR}
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
            <>
              <CommitSelector
                commits={data.commits}
                selectedCommit={selectedCommit}
                selectCommit={selectCommit}
              />
              <FileViewControls
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
                canExpand={effectiveExpandedFiles.size < files.length}
              />
            </>
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
              {selectedCommit &&
                (() => {
                  const commit = data.commits.find((c) => c.sha === selectedCommit);
                  return commit ? (
                    <CommitMessagePanel
                      commit={commit}
                      comments={getCommitMessageComments(selectedCommit)}
                      isCommenting={commentingOnCommitMessage}
                      setIsCommenting={setCommentingOnCommitMessage}
                      openCommitMessageComment={openCommitMessageComment}
                      newComment={newComment}
                      setNewComment={setNewComment}
                      addComment={addCommitMessageComment}
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
                  ) : null;
                })()}
              {files.map((file) => (
                <FileDiffCard
                  key={file.path}
                  file={file}
                  diff={diff}
                  fileComments={getFileComments(file.path)}
                  commitSpecificComments={getCommitSpecificFileComments(file.path)}
                  commits={data.commits}
                  onJumpToFile={jumpToFile}
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
                  openLineComment={openLineComment}
                  lastClickedLine={lastClickedLine}
                  setLastClickedLine={setLastClickedLine}
                  isSelectingComment={isSelectingComment}
                  setIsSelectingComment={setIsSelectingComment}
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
