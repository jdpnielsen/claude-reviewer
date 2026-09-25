'use client';

import { CheckCheck, Combine, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryState } from 'nuqs';
import { useState, useEffect, useRef, use } from 'react';

import {
  useAddCommentMutation,
  useAddReplyMutation,
  useDeleteCommentMutation,
  useDeletePRMutation,
  useEditCommentMutation,
  useMarkCommitMessageReviewedMutation,
  useMarkCommitReviewedMutation,
  useMarkFileReviewedMutation,
  usePRCommentsPollQuery,
  usePRQuery,
  useRequestAIReviewMutation,
  useResolveCommentMutation,
  useSetPRStatusMutation,
  useSubmitReviewMutation,
  useSyncPRMutation,
  useUnmarkCommitMessageReviewedMutation,
  useUnmarkCommitReviewedMutation,
  useUnmarkFileReviewedMutation,
} from '@/app/prs/[id]/queries';
import type {
  Comment,
  CommentingAt,
  EditingComment,
  LastClickedLine,
  PRData,
} from '@/app/prs/[id]/types';
import {
  buildContextUrl,
  commentAnchorId,
  commentUuidFromHash,
  commitFullMessage,
  contextFileKey,
  findReviewedMark,
  findReviewedMessageMark,
  shouldCollapseByDefault,
  statusConfig,
} from '@/app/prs/[id]/utils';
import { useConfirm } from '@/components/ConfirmDialog';
import AutosquashNotice, { autosquashTooltip } from '@/components/pr/AutosquashNotice';
import CommitMessagePanel from '@/components/pr/CommitMessagePanel';
import CommitSelector from '@/components/pr/CommitSelector';
import ConversationTab from '@/components/pr/ConversationTab';
import FileDiffCard from '@/components/pr/FileDiffCard';
import FileViewControls from '@/components/pr/FileViewControls';
import PRHeader from '@/components/pr/PRHeader';
import PRSidebar from '@/components/pr/PRSidebar';
import PRTabs, { type PRViewTab } from '@/components/pr/PRTabs';
import ReviewPanel from '@/components/pr/ReviewPanel';
import { TargetedCommentContext } from '@/components/pr/TargetedCommentContext';
import { apiClient, ApiError, buildQuery } from '@/lib/api-client';
import { isFixupishSubject } from '@/lib/autosquash';
import {
  ChangeType,
  CommentResolutionMode,
  CommentTargetType,
  PullRequestStatus,
  ReviewAction,
} from '@/lib/enum';
import { useAuthorsQuery } from '@/lib/queries/authors';
import { insertSuggestion } from '@/lib/suggestions';

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
  // 'autosquash' while previewing the branch as `rebase -i --autosquash`
  // would leave it - see the autosquash field on PRData.
  const [view, setView] = useQueryState('view');
  const autosquashOn = view === 'autosquash';
  const [commentingAt, setCommentingAt] = useState<CommentingAt | null>(null);
  const [commentingOnCommitMessage, setCommentingOnCommitMessage] = useState(false);
  const [lastClickedLine, setLastClickedLine] = useState<LastClickedLine | null>(null);
  // True from mousedown on a gutter line until mouseup, however far away that
  // lands - suppresses the comment form while true so a drag-select doesn't
  // shift the page layout under the pointer mid-drag (commentingAt itself
  // still updates live, so the range highlight grows as you drag).
  const [isSelectingComment, setIsSelectingComment] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [resolutionMode, setResolutionMode] = useState<CommentResolutionMode>(
    CommentResolutionMode.Fix,
  );
  const [editingComment, setEditingComment] = useState<EditingComment | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [reviewSummary, setReviewSummary] = useState('');
  const [previewMode, setPreviewMode] = useState<Set<string>>(new Set());
  // Track expanded context: key is contextCacheKey(...), value is array of lines
  const [expandedContext, setExpandedContext] = useState<Map<string, string[]>>(new Map());
  const [loadingContext, setLoadingContext] = useState<Set<string>>(new Set());
  // Each file's total line count as reported by the context API, keyed by
  // contextFileKey(...). A diff only describes the parts that changed, so this
  // is the only thing that tells the expand-down control where a file ends.
  const [fileLineCounts, setFileLineCounts] = useState<Map<string, number>>(new Map());
  // Track which files show all lines (for large diffs)
  const [showAllLines, setShowAllLines] = useState<Set<string>>(new Set());
  // Track collapsed folders in sidebar
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  // Set by jumpToComment so the scroll can happen once the Files tab has
  // actually mounted - see the effect below.
  const [pendingScrollTarget, setPendingScrollTarget] = useState<Comment | null>(null);
  // The thread the last "View in Files" link pointed at - highlighted and
  // opened wherever it renders (see TargetedCommentContext).
  const [targetedCommentUuid, setTargetedCommentUuid] = useState<string | null>(null);
  // Set when a `?commit=` link turned out to be stale (rebase/amend/force-push
  // rewrote it) and couldn't be redirected to where it ended up - see the
  // effect below.
  const [commitNotice, setCommitNotice] = useState<string | null>(null);

  // Switching `selectedCommit` changes this query's key; `keepPreviousData`
  // keeps the sidebar/diff pane mounted with the previous commit's data
  // (isFetching: true) instead of unmounting while the new one loads - this
  // is what the old manual latestRequestRef race-guard used to do by hand.
  const prQuery = usePRQuery(id, selectedCommit, view);
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
  const markFileReviewedMutation = useMarkFileReviewedMutation(id);
  const unmarkFileReviewedMutation = useUnmarkFileReviewedMutation(id);
  const markCommitReviewedMutation = useMarkCommitReviewedMutation(id);
  const unmarkCommitReviewedMutation = useUnmarkCommitReviewedMutation(id);
  const markCommitMessageReviewedMutation = useMarkCommitMessageReviewedMutation(id);
  const unmarkCommitMessageReviewedMutation = useUnmarkCommitMessageReviewedMutation(id);

  const data: PRData | undefined = prQuery.data && {
    ...prQuery.data,
    comments: commentsQuery.data?.comments ?? prQuery.data.comments,
    commits: commentsQuery.data?.commits ?? prQuery.data.commits,
    reviewedFiles: commentsQuery.data?.reviewedFiles ?? prQuery.data.reviewedFiles,
    reviewedMessages: commentsQuery.data?.reviewedMessages ?? prQuery.data.reviewedMessages,
    reviewedCommits: commentsQuery.data?.reviewedCommits ?? prQuery.data.reviewedCommits,
    previewCommits: commentsQuery.data?.previewCommits ?? prQuery.data.previewCommits,
    pr: { ...prQuery.data.pr, status: commentsQuery.data?.pr.status ?? prQuery.data.pr.status },
  };

  // What the commit selector steps through: the PR's own commits, or the
  // squashed ones while the autosquash preview is on. `data.commits` itself
  // stays the PR's own either way. Comments and reviewed marks can be keyed
  // to either, so the tags naming their commit look in both.
  const autosquash = autosquashOn ? (prQuery.data?.autosquash ?? null) : null;
  const squashed = autosquash?.error === null ? autosquash : null;
  const displayCommits = squashed ? squashed.commits : (data?.commits ?? []);
  const labelCommits = [
    ...(data?.commits ?? []),
    ...(squashed?.commits ?? []),
    ...(data?.previewCommits ?? []),
  ];
  const hasFixupCommits = !!data?.commits.some((c) => isFixupishSubject(c.message));

  // A PR with exactly one commit has no real "cumulative diff (all commits)"
  // view distinct from that commit's own diff - getLatestDiff(base..head) and
  // getCommitDiff(commit) return identical content in that case. So the Files
  // tab treats this commit as implicitly selected even when selectedCommit is
  // still null (the default, unpicked state): the commit message panel shows,
  // and comments are matched as if commit_sha null and this commit's sha were
  // the same value (see normalizeCommitSha below) - which also keeps any
  // comment added before this PR happened to be the only commit (commit_sha
  // null) visible inline instead of orphaned.
  const soleCommit = displayCommits.length === 1 ? displayCommits[0] : null;
  const displayedCommitSha = selectedCommit ?? soleCommit?.sha ?? null;
  const displayedSquashed = squashed?.commits.find((c) => c.sha === displayedCommitSha);
  const normalizeCommitSha = (sha: string | null) =>
    soleCommit && sha === null ? soleCommit.sha : sha;

  // A `?commit=<sha>` link goes stale the moment a rebase/amend/force-push
  // changes that commit's SHA - the API 400s with 'Unknown commit for this
  // PR' rather than erroring the whole page. Detected here (not just inside
  // the effect below) so the render-gate further down can treat it as a
  // loading state rather than flashing the dead-end error screen for a tick
  // before the redirect below takes effect.
  const unknownCommitError =
    prQuery.error instanceof ApiError && prQuery.error.status === 400
      ? (prQuery.error.data as
          | { relocatedTo?: string | null; inAutosquashPreview?: boolean }
          | undefined)
      : undefined;
  const isUnknownCommitError = Boolean(unknownCommitError && 'relocatedTo' in unknownCommitError);

  // If relocateComments() has ever recorded where that SHA ended up, jump
  // straight there (URL self-heals, no error ever shown); otherwise fall
  // back to the cumulative view with a dismissible notice instead.
  useEffect(() => {
    if (!isUnknownCommitError) return;
    if (unknownCommitError?.relocatedTo) {
      setSelectedCommit(unknownCommitError.relocatedTo);
    } else if (unknownCommitError?.inAutosquashPreview) {
      // A link to a comment made in the autosquash preview.
      setView('autosquash');
    } else {
      setCommitNotice(
        autosquashOn
          ? "This commit isn't in the autosquash preview - showing all commits instead."
          : 'This commit is no longer part of the PR - showing the latest diff instead.',
      );
      setSelectedCommit(null);
    }
    // Only re-run when a new failed fetch produces a new error object, not
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prQuery.error]);

  // The preview is built from the commits the branch had when it was
  // fetched; once polling sees the branch move on, rebuild it rather than
  // keep showing a squash of commits that are gone.
  const squashedSourceShas = squashed?.sourceShas.join(',');
  const polledShas = commentsQuery.data?.commits.map((c) => c.sha).join(',');
  useEffect(() => {
    if (squashedSourceShas && polledShas && squashedSourceShas !== polledShas) {
      prQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [squashedSourceShas, polledShas]);

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
    const soleCommitSha = prQuery.data.commits.length === 1 ? prQuery.data.commits[0].sha : null;
    const effectiveCommitSha = selectedCommit ?? soleCommitSha;
    const defaultOpen = files.filter(
      (f) =>
        f.changeType !== ChangeType.Deleted &&
        !shouldCollapseByDefault(
          f,
          !!findReviewedMark(prQuery.data!.reviewedFiles, f.path, effectiveCommitSha),
        ),
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
      const contextData = await apiClient.get<{ lines: string[]; totalLines: number }>(
        buildContextUrl(id, filePath, startLine, endLine, displayedCommitSha),
      );
      setExpandedContext((prev) => {
        const next = new Map(prev);
        const existing = next.get(key) || [];
        next.set(key, [...existing, ...contextData.lines]);
        return next;
      });
      setFileLineCounts((prev) =>
        new Map(prev).set(contextFileKey(displayedCommitSha, filePath), contextData.totalLines),
      );
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

  // Keeps the same change on screen either way: turning the preview on
  // lets the API redirect a folded commit to the squashed one built from it
  // (see relocatedTo in the GET route); turning it off goes back to the PR
  // commit a squashed one was built from.
  const toggleAutosquash = () => {
    if (autosquashOn) {
      const squashedCommit = squashed?.commits.find((c) => c.sha === selectedCommit);
      if (squashedCommit) setSelectedCommit(squashedCommit.originalSha);
      setView(null);
    } else {
      setView('autosquash');
    }
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

  // Scroll within the main container, not the whole page
  const scrollIntoMain = (element: Element | null) => {
    const mainContainer = document.querySelector('.pr-main');
    if (element && mainContainer) {
      const containerRect = mainContainer.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const scrollTop = mainContainer.scrollTop + (elementRect.top - containerRect.top) - 20;
      mainContainer.scrollTop = scrollTop;
    }
  };

  const scrollToDiff = (path: string) => {
    scrollIntoMain(document.getElementById(`file-${path.replace(/[^a-zA-Z0-9]/g, '-')}`));
  };

  // Run when a "View in Files" link (see CommentLink) is followed in this
  // tab; the link itself does the navigating, to the commit the comment was
  // made against. Force-expands the comment's file (explicit override, same
  // as toggleFile's expand branch) and defers the scroll until that commit's
  // diff has finished loading.
  const jumpToComment = (comment: Comment) => {
    if (comment.target_type === CommentTargetType.Line) {
      const filePath = comment.file_path;
      setExpandedFiles((prev) => new Set(prev).add(filePath));
      setCollapsedFiles((prev) => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
    }
    setTargetedCommentUuid(comment.uuid);
    setPendingScrollTarget(comment);
  };

  // The same jump for a link that loaded this page fresh - a new tab, a
  // reload, a pasted URL - once the comment it names has loaded.
  const handledCommentHash = useRef(false);
  useEffect(() => {
    if (!data || handledCommentHash.current) return;
    handledCommentHash.current = true;
    const uuid = commentUuidFromHash(window.location.hash);
    const item = uuid ? data.comments.find((c) => c.comment.uuid === uuid) : undefined;
    if (item) jumpToComment(item.comment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    // Wait for a commit switch triggered by the link to actually land -
    // otherwise this can fire while the previous commit's files are still
    // rendered (keepPreviousData) and scroll to nothing, or the wrong file.
    if (activeTab !== 'files' || !pendingScrollTarget || prQuery.isFetching) return;
    // Falls back to the file when the thread isn't on screen, e.g. a large
    // file whose comment sits past the lines shown by default.
    const thread = document.getElementById(commentAnchorId(pendingScrollTarget.uuid));
    if (thread) {
      scrollIntoMain(thread);
    } else {
      scrollToDiff(pendingScrollTarget.file_path);
    }
    setPendingScrollTarget(null);
    // Only re-run when the tab, pending target, or fetch state changes -
    // the scroll reads the DOM directly and isn't itself reactive state.
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
      setResolutionMode(CommentResolutionMode.Fix);
    }
    setCommentingAt(target);
  };

  const openCommitMessageComment = () => {
    setCommentingAt(null);
    setNewComment('');
    setResolutionMode(CommentResolutionMode.Fix);
    setCommentingOnCommitMessage(true);
  };

  // Switching commits changes which diff/commit message is even on screen -
  // an in-progress draft no longer refers to anything visible, and
  // submitting it would attach it to the wrong commit_sha.
  useEffect(() => {
    setCommentingAt(null);
    setCommentingOnCommitMessage(false);
    setNewComment('');
    setResolutionMode(CommentResolutionMode.Fix);
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
      resolutionMode,
    });
    setNewComment('');
    setResolutionMode(CommentResolutionMode.Fix);
    setCommentingAt(null);
    setLastClickedLine(null);
  };

  const addCommitMessageComment = () => {
    if (!displayedCommitSha || !newComment.trim() || !data) return;
    addCommentMutation.mutate({
      targetType: CommentTargetType.CommitMessage,
      commitSha: displayedCommitSha,
      content: newComment,
      resolutionMode,
    });
    setNewComment('');
    setResolutionMode(CommentResolutionMode.Fix);
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

  // "Insert suggestion" in a reply form, seeded - like a new comment's - with
  // the lines a suggestion there would replace: the comment's range as it
  // reads at the commit it was made against (head for the cumulative view),
  // or the whole commit message. Fetched rather than read from the diff on
  // screen, since the Conversation tab has no diff and the Files tab may be
  // showing a different commit than the comment's.
  const insertReplySuggestion = async (comment: Comment) => {
    let seedLines: string[];
    if (comment.target_type === CommentTargetType.CommitMessage) {
      const commit = labelCommits.find((c) => c.sha === comment.commit_sha);
      if (!commit) return;
      seedLines = commitFullMessage(commit).split('\n');
    } else {
      try {
        const context = await apiClient.get<{ lines: string[] }>(
          buildContextUrl(
            id,
            comment.file_path,
            comment.line_number,
            comment.end_line_number,
            comment.commit_sha,
          ),
        );
        seedLines = context.lines;
      } catch (e) {
        // Nothing to seed with - an empty fence would read as "delete these
        // lines", so insert nothing rather than that.
        console.error('Failed to fetch suggestion lines:', e);
        return;
      }
    }
    setReplyContent((prev) => insertSuggestion(prev, seedLines));
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
        normalizeCommitSha(c.comment.commit_sha) === normalizeCommitSha(selectedCommit),
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
  // relevant to that view already comes back from getFileComments. Also
  // empty for a one-commit PR - there, normalizeCommitSha already folds every
  // comment into getFileComments's inline view, so surfacing them again here
  // would just duplicate them.
  const getCommitSpecificFileComments = (filePath: string) => {
    if (!data || selectedCommit !== null || soleCommit) return [];
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
    if (!file) return false;
    return (
      file.changeType !== ChangeType.Deleted &&
      !shouldCollapseByDefault(file, isFileReviewed(filePath))
    );
  };

  // Whether `filePath` has a current (non-stale) reviewed mark in the
  // context the Files tab is showing right now - the cumulative diff, or one
  // specific commit's own diff (including a one-commit PR's implicit
  // selection - see displayedCommitSha above).
  const isFileReviewed = (filePath: string): boolean =>
    !!data && !!findReviewedMark(data.reviewedFiles, filePath, displayedCommitSha);

  const toggleFileReviewed = (filePath: string) => {
    const params = { filePath, commitSha: displayedCommitSha };
    if (isFileReviewed(filePath)) {
      unmarkFileReviewedMutation.mutate(params);
    } else {
      markFileReviewedMutation.mutate(params);
      // Collapse right away instead of waiting for the next load/refetch to
      // pick up the new mark (see the data-load effect above) - the reviewer
      // just said they're done with this file, so there's no reason to make
      // them wait or collapse it themselves.
      if (isFileExpanded(filePath)) toggleFile(filePath);
    }
  };

  // Whether the *currently displayed* commit's message has a current mark of
  // its own - which says nothing about the files that commit touches, and
  // vice versa. Reviewing the wording and reviewing the change are separate
  // jobs, often finished at different times.
  const isDisplayedMessageReviewed = (): boolean =>
    !!data && !!findReviewedMessageMark(data.reviewedMessages, displayedCommitSha);

  const toggleDisplayedMessageReviewed = () => {
    if (!displayedCommitSha) return;
    if (isDisplayedMessageReviewed()) {
      unmarkCommitMessageReviewedMutation.mutate(displayedCommitSha);
    } else {
      markCommitMessageReviewedMutation.mutate(displayedCommitSha);
    }
  };

  // Commits the review has started on - a current mark of their own (a file
  // or the message), or a comment on them - that aren't reviewedCommits yet:
  // amber in the commit selector.
  const partiallyReviewedCommits = data
    ? [
        ...new Set(
          [
            ...[...data.reviewedFiles, ...data.reviewedMessages].filter((m) => m.current),
            ...data.comments.map((c) => c.comment),
          ]
            .map((m) => m.commit_sha)
            .filter((sha): sha is string => sha !== null),
        ),
      ].filter((sha) => !data.reviewedCommits.includes(sha))
    : [];

  // Whether the *currently displayed* commit is reviewed in full - message
  // marked and every file its own diff touches marked - i.e. the
  // tab bar's "mark commit reviewed" button was used, or every
  // piece of it was signed off one at a time. Delegates to the
  // server-computed reviewedCommits (see the GET /api/prs/[id] route) rather
  // than re-deriving it from data.files, so the commit selector's per-commit
  // badges and this tab-bar button always agree.
  const isDisplayedCommitReviewed = (): boolean =>
    !!data && !!displayedCommitSha && data.reviewedCommits.includes(displayedCommitSha);

  const toggleDisplayedCommitReviewed = () => {
    if (!displayedCommitSha || !data) return;
    if (isDisplayedCommitReviewed()) {
      unmarkCommitReviewedMutation.mutate(displayedCommitSha);
    } else {
      markCommitReviewedMutation.mutate(displayedCommitSha);
      // Same immediate-collapse feedback as toggleFileReviewed, for every
      // file this commit touches at once.
      for (const file of data.files) {
        if (isFileExpanded(file.path)) toggleFile(file.path);
      }
    }
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
  const commitQuery = buildQuery({ commit: selectedCommit, view });
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
            views and AI review need the checkout back. If the branch is still in another checkout,{' '}
            <code>claude-reviewer update {pr.uuid} --repo &lt;path&gt;</code> moves the PR there;
            otherwise use <strong>Delete</strong> to clear it out.
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
                commits={displayCommits}
                selectedCommit={selectedCommit}
                selectCommit={selectCommit}
                reviewedCommits={data.reviewedCommits}
                partiallyReviewedCommits={partiallyReviewedCommits}
              />
              <FileViewControls
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
                canExpand={effectiveExpandedFiles.size < files.length}
              />
              {data.repoAvailable && (hasFixupCommits || autosquashOn) && (
                <button
                  type="button"
                  className={`reviewed-toggle toolbar-compact-2 ${autosquashOn ? 'active' : ''}`}
                  onClick={toggleAutosquash}
                  title={autosquashTooltip(autosquash, data.commits.length)}
                  aria-label="Autosquash preview"
                >
                  <Combine size={14} />
                  <span className="toolbar-label">Autosquash preview</span>
                </button>
              )}
              {displayedCommitSha && (
                <button
                  type="button"
                  className={`reviewed-toggle toolbar-compact-2 ${isDisplayedCommitReviewed() ? 'active' : ''}`}
                  onClick={toggleDisplayedCommitReviewed}
                  title={
                    isDisplayedCommitReviewed()
                      ? 'Marked reviewed - this commit message and every file it touches'
                      : "Mark this commit's message and every file it touches as reviewed"
                  }
                  aria-label={
                    isDisplayedCommitReviewed() ? 'Commit reviewed' : 'Mark commit reviewed'
                  }
                >
                  <CheckCheck size={14} />
                  <span className="toolbar-label">
                    {isDisplayedCommitReviewed() ? 'Commit reviewed' : 'Mark commit reviewed'}
                  </span>
                </button>
              )}
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
          <TargetedCommentContext value={targetedCommentUuid}>
            {activeTab === 'files' ? (
              <>
                {autosquash && <AutosquashNotice view={autosquash} />}
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
                {displayedCommitSha &&
                  (() => {
                    const commit = displayCommits.find((c) => c.sha === displayedCommitSha);
                    return commit ? (
                      <CommitMessagePanel
                        commit={commit}
                        absorbed={displayedSquashed?.absorbed}
                        messageNeedsEdit={displayedSquashed?.messageNeedsEdit}
                        comments={getCommitMessageComments(displayedCommitSha)}
                        isMessageReviewed={isDisplayedMessageReviewed()}
                        messageReviewedVia={
                          findReviewedMessageMark(data.reviewedMessages, displayedCommitSha)?.via
                        }
                        toggleMessageReviewed={toggleDisplayedMessageReviewed}
                        isCommenting={commentingOnCommitMessage}
                        setIsCommenting={setCommentingOnCommitMessage}
                        openCommitMessageComment={openCommitMessageComment}
                        newComment={newComment}
                        setNewComment={setNewComment}
                        resolutionMode={resolutionMode}
                        setResolutionMode={setResolutionMode}
                        addComment={addCommitMessageComment}
                        editingComment={editingComment}
                        setEditingComment={setEditingComment}
                        editComment={editComment}
                        replyingTo={replyingTo}
                        setReplyingTo={setReplyingTo}
                        replyContent={replyContent}
                        setReplyContent={setReplyContent}
                        addReply={addReply}
                        insertReplySuggestion={insertReplySuggestion}
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
                    commits={labelCommits}
                    displayedCommitSha={displayedCommitSha}
                    fileLineCount={
                      fileLineCounts.get(contextFileKey(displayedCommitSha, file.path)) ?? null
                    }
                    repoPath={data.repoAvailable ? pr.repo_path : null}
                    isReviewed={isFileReviewed(file.path)}
                    reviewedVia={
                      findReviewedMark(data.reviewedFiles, file.path, displayedCommitSha)?.via
                    }
                    toggleReviewed={() => toggleFileReviewed(file.path)}
                    prId={id}
                    onJumpToComment={jumpToComment}
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
                    resolutionMode={resolutionMode}
                    setResolutionMode={setResolutionMode}
                    addComment={addComment}
                    editingComment={editingComment}
                    setEditingComment={setEditingComment}
                    editComment={editComment}
                    replyingTo={replyingTo}
                    setReplyingTo={setReplyingTo}
                    replyContent={replyContent}
                    setReplyContent={setReplyContent}
                    addReply={addReply}
                    insertReplySuggestion={insertReplySuggestion}
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
                commits={labelCommits}
                prId={id}
                onJumpToComment={jumpToComment}
                editingComment={editingComment}
                setEditingComment={setEditingComment}
                editComment={editComment}
                replyingTo={replyingTo}
                setReplyingTo={setReplyingTo}
                replyContent={replyContent}
                setReplyContent={setReplyContent}
                addReply={addReply}
                insertReplySuggestion={insertReplySuggestion}
                resolveComment={resolveComment}
                deleteComment={deleteComment}
              />
            )}
          </TargetedCommentContext>
        </div>
      </div>
    </main>
  );
}
