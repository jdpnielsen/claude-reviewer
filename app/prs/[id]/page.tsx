'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState, useEffect, useRef, use } from 'react';

import type {
  CommentingAt,
  CommentReply,
  CommentWithReplies,
  EditingComment,
  FileInfo,
  LastClickedLine,
  PRData,
} from './types';
import { statusConfig } from './utils';
import { useConfirm } from '@/components/ConfirmDialog';
import FileDiffCard from '@/components/pr/FileDiffCard';
import PRHeader from '@/components/pr/PRHeader';
import PRSidebar from '@/components/pr/PRSidebar';
import { AuthorKind, ReviewAction } from '@/lib/enum';

export default function PRPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const confirm = useConfirm();
  const [data, setData] = useState<PRData | null>(null);
  const [loading, setLoading] = useState(true);
  // Set while a *subsequent* fetchPR (e.g. switching commits) is in flight.
  // Unlike `loading`, this never unmounts the sidebar/commit list - it only
  // signals that the diff pane is refreshing.
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commentingAt, setCommentingAt] = useState<CommentingAt | null>(null);
  const [lastClickedLine, setLastClickedLine] = useState<LastClickedLine | null>(null);
  const [newComment, setNewComment] = useState('');
  const [editingComment, setEditingComment] = useState<EditingComment | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [defaultAuthorName, setDefaultAuthorName] = useState('reviewer');
  const [reviewSummary, setReviewSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [requestingAI, setRequestingAI] = useState(false);
  const [previewMode, setPreviewMode] = useState<Set<string>>(new Set());
  // Track expanded context: key is "filePath:hunkIndex:direction", value is array of lines
  const [expandedContext, setExpandedContext] = useState<Map<string, string[]>>(new Map());
  const [loadingContext, setLoadingContext] = useState<Set<string>>(new Set());
  // Track which files show all lines (for large diffs)
  const [showAllLines, setShowAllLines] = useState<Set<string>>(new Set());
  // Track collapsed folders in sidebar
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  // Guards against out-of-order fetchPR responses: whichever fetchPR call was
  // *started* most recently owns this ref's current value. If a response comes
  // back and the ref has since moved on (a newer fetch started), that response
  // is stale and must not be applied - the sidebar (e.g. selectedCommit) may
  // already reflect a later click than the one this response belongs to.
  const latestRequestRef = useRef(0);

  const fetchContext = async (
    filePath: string,
    startLine: number,
    endLine: number,
    key: string,
  ) => {
    if (loadingContext.has(key)) return;

    setLoadingContext((prev) => new Set(prev).add(key));
    try {
      const res = await fetch(
        `/api/prs/${id}/context?file=${encodeURIComponent(filePath)}&start=${startLine}&end=${endLine}`,
      );
      if (res.ok) {
        const data = await res.json();
        setExpandedContext((prev) => {
          const next = new Map(prev);
          const existing = next.get(key) || [];
          next.set(key, [...existing, ...data.lines]);
          return next;
        });
      }
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

  useEffect(() => {
    fetchPR();

    // Poll for comment updates every 5 seconds
    const interval = setInterval(() => {
      // Only fetch comments, not the full PR data (to preserve UI state)
      fetch(`/api/prs/${id}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((prData) => {
          if (prData) {
            setData((prev) =>
              prev
                ? {
                    ...prev,
                    comments: prData.comments,
                    pr: { ...prev.pr, status: prData.pr.status },
                  }
                : prData,
            );
          }
        })
        .catch(() => {}); // Silently ignore polling errors
    }, 5000);

    return () => clearInterval(interval);
    // fetchPR reads `data` only to pick a loading indicator, and also sets `data` -
    // adding it as a dependency would refetch every time data changes, looping forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    fetch('/api/authors')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const defaultHuman = data?.authors?.find(
          (a: { isDefaultHuman: boolean; name: string }) => a.isDefaultHuman,
        );
        if (defaultHuman) setDefaultAuthorName(defaultHuman.name);
      })
      .catch(() => {
        // Keep the "reviewer" fallback - replying must never be blocked by this.
      });
  }, []);

  const fetchPR = async (commit: string | null = selectedCommit) => {
    // Claim this call's slot as the most recent request. If a later fetchPR
    // call claims a higher requestId before this one's response arrives,
    // this call's response is stale and must be ignored below.
    const requestId = ++latestRequestRef.current;
    // The very first load has no data yet, so a full-page spinner is expected.
    // Once data exists, this is a reload triggered by switching commits -
    // keep the sidebar/file-tree mounted and only flag the diff pane as busy.
    const isInitialLoad = data === null;
    if (isInitialLoad) {
      setLoading(true);
    } else {
      setDiffLoading(true);
    }
    try {
      const query = commit ? `?commit=${encodeURIComponent(commit)}` : '';
      const res = await fetch(`/api/prs/${id}${query}`);
      if (!res.ok) throw new Error('PR not found');
      const prData = await res.json();
      // A newer fetchPR call started while this one was in flight (e.g. the
      // user clicked another commit before this response arrived) - that
      // newer call owns the final state now, so drop this stale response
      // rather than clobbering it.
      if (latestRequestRef.current !== requestId) return;
      setData(prData);
      // For large PRs (>10 files), only expand first 3 files for performance
      // For smaller PRs, expand all
      const files = prData.files as FileInfo[];
      if (files.length > 10) {
        setExpandedFiles(new Set(files.slice(0, 3).map((f) => f.path)));
      } else {
        setExpandedFiles(new Set(files.map((f) => f.path)));
      }
    } catch (e) {
      if (latestRequestRef.current === requestId) {
        setError(e instanceof Error ? e.message : 'Error loading PR');
      }
    } finally {
      // Only the most recent call clears the loading flags. A stale call's
      // finally would otherwise flip diffLoading/loading to false while a
      // newer fetch is still in flight, causing the spinner to disappear
      // prematurely; the newer call's own finally will clear them once it
      // settles.
      if (latestRequestRef.current === requestId) {
        setLoading(false);
        setDiffLoading(false);
      }
    }
  };

  const selectCommit = (sha: string | null) => {
    setSelectedCommit(sha);
    fetchPR(sha);
  };

  const toggleFile = (path: string) => {
    const newExpanded = new Set(expandedFiles);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
    }
    setExpandedFiles(newExpanded);
  };

  const expandAll = () => {
    if (!data) return;
    setExpandedFiles(new Set(data.files.map((f) => f.path)));
  };

  const collapseAll = () => {
    setExpandedFiles(new Set());
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

  const addComment = async () => {
    if (!commentingAt || !newComment.trim() || !data) return;

    const tempUuid = `temp-${Date.now()}`;
    const newCommentObj: CommentWithReplies = {
      comment: {
        id: Date.now(),
        uuid: tempUuid,
        file_path: commentingAt.file,
        line_number: commentingAt.startLine,
        end_line_number: commentingAt.endLine,
        commit_sha: selectedCommit,
        line_type: commentingAt.lineType,
        content: newComment,
        resolved: false,
        created_at: new Date().toISOString(),
      },
      replies: [],
    };

    // Optimistically update local state
    setData({
      ...data,
      comments: [...data.comments, newCommentObj],
    });
    setNewComment('');
    setCommentingAt(null);
    setLastClickedLine(null);

    try {
      const res = await fetch(`/api/prs/${id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: commentingAt.file,
          lineNumber: commentingAt.startLine,
          endLineNumber: commentingAt.endLine,
          lineType: commentingAt.lineType,
          commitSha: selectedCommit,
          content: newComment,
        }),
      });
      const result = await res.json();
      // Update with real UUID from server
      setData((prev) =>
        prev
          ? {
              ...prev,
              comments: prev.comments.map((c) =>
                c.comment.uuid === tempUuid
                  ? { ...c, comment: { ...c.comment, uuid: result.uuid } }
                  : c,
              ),
            }
          : prev,
      );
    } catch {
      alert('Error adding comment');
      // Revert on error
      setData((prev) =>
        prev
          ? { ...prev, comments: prev.comments.filter((c) => c.comment.uuid !== tempUuid) }
          : prev,
      );
    }
  };

  const editComment = async () => {
    if (!editingComment || !editingComment.content.trim() || !data) return;

    const originalCommentWithReplies = data.comments.find(
      (c) => c.comment.uuid === editingComment.uuid,
    );

    // Optimistically update local state
    setData({
      ...data,
      comments: data.comments.map((c) =>
        c.comment.uuid === editingComment.uuid
          ? { ...c, comment: { ...c.comment, content: editingComment.content } }
          : c,
      ),
    });
    setEditingComment(null);

    try {
      await fetch(`/api/prs/${id}/comments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commentUuid: editingComment.uuid,
          content: editingComment.content,
        }),
      });
    } catch {
      alert('Error updating comment');
      // Revert on error
      if (originalCommentWithReplies) {
        setData((prev) =>
          prev
            ? {
                ...prev,
                comments: prev.comments.map((c) =>
                  c.comment.uuid === editingComment.uuid ? originalCommentWithReplies : c,
                ),
              }
            : prev,
        );
      }
    }
  };

  const addReply = async (commentUuid: string) => {
    if (!replyContent.trim() || !data) return;

    const tempReply: CommentReply = {
      id: Date.now(),
      uuid: `temp-${Date.now()}`,
      author: defaultAuthorName,
      author_kind: AuthorKind.Human,
      content: replyContent,
      created_at: new Date().toISOString(),
    };

    // Optimistically update local state
    setData({
      ...data,
      comments: data.comments.map((c) =>
        c.comment.uuid === commentUuid ? { ...c, replies: [...c.replies, tempReply] } : c,
      ),
    });
    setReplyContent('');
    setReplyingTo(null);

    try {
      const res = await fetch(`/api/prs/${id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commentUuid,
          content: replyContent,
        }),
      });
      const result = await res.json();
      // Update with real UUID from server
      setData((prev) =>
        prev
          ? {
              ...prev,
              comments: prev.comments.map((c) =>
                c.comment.uuid === commentUuid
                  ? {
                      ...c,
                      replies: c.replies.map((r) =>
                        r.uuid === tempReply.uuid ? { ...r, uuid: result.uuid } : r,
                      ),
                    }
                  : c,
              ),
            }
          : prev,
      );
    } catch {
      alert('Error adding reply');
      // Revert on error
      setData((prev) =>
        prev
          ? {
              ...prev,
              comments: prev.comments.map((c) =>
                c.comment.uuid === commentUuid
                  ? { ...c, replies: c.replies.filter((r) => r.uuid !== tempReply.uuid) }
                  : c,
              ),
            }
          : prev,
      );
    }
  };

  const resolveComment = async (commentUuid: string, resolved: boolean) => {
    if (!data) return;

    // Optimistically update local state
    setData({
      ...data,
      comments: data.comments.map((c) =>
        c.comment.uuid === commentUuid ? { ...c, comment: { ...c.comment, resolved } } : c,
      ),
    });

    try {
      await fetch(`/api/prs/${id}/comments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentUuid, resolved }),
      });
    } catch {
      alert('Error updating comment');
      // Revert on error
      setData((prev) =>
        prev
          ? {
              ...prev,
              comments: prev.comments.map((c) =>
                c.comment.uuid === commentUuid
                  ? { ...c, comment: { ...c.comment, resolved: !resolved } }
                  : c,
              ),
            }
          : prev,
      );
    }
  };

  const deleteComment = async (commentUuid: string, replyCount: number) => {
    if (!data) return;

    const message =
      replyCount > 0
        ? `Delete this comment and its ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}?`
        : 'Delete this comment?';
    if (!(await confirm(message, { danger: true }))) return;

    const originalCommentWithReplies = data.comments.find((c) => c.comment.uuid === commentUuid);

    // Optimistically remove from local state
    setData({
      ...data,
      comments: data.comments.filter((c) => c.comment.uuid !== commentUuid),
    });

    try {
      await fetch(`/api/prs/${id}/comments?uuid=${commentUuid}`, { method: 'DELETE' });
    } catch {
      alert('Error deleting comment');
      // Revert on error
      if (originalCommentWithReplies) {
        setData((prev) =>
          prev ? { ...prev, comments: [...prev.comments, originalCommentWithReplies] } : prev,
        );
      }
    }
  };

  const submitReview = async (
    action: typeof ReviewAction.Approve | typeof ReviewAction.RequestChanges,
  ) => {
    setSubmitting(true);
    try {
      await fetch(`/api/prs/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, summary: reviewSummary }),
      });
      setReviewSummary('');
      fetchPR();
    } catch {
      alert('Error submitting review');
    } finally {
      setSubmitting(false);
    }
  };

  const requestAIReview = async () => {
    setRequestingAI(true);
    try {
      const res = await fetch(`/api/prs/${id}/ai-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await res.json();
      if (!res.ok) {
        alert(`AI Review failed: ${result.error}`);
      } else {
        // Refresh to show new comments
        fetchPR();
      }
    } catch {
      alert('Error requesting AI review');
    } finally {
      setRequestingAI(false);
    }
  };

  // Get comments for a specific file
  const getFileComments = (filePath: string): CommentWithReplies[] => {
    if (!data) return [];
    return data.comments.filter(
      (c) => c.comment.file_path === filePath && c.comment.commit_sha === selectedCommit,
    );
  };

  if (loading) {
    return (
      <main className="container">
        <div className="loading">Loading PR...</div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="container">
        <div className="error">{error || 'PR not found'}</div>
        <Link href="/">Back to list</Link>
      </main>
    );
  }

  const { pr, diff, files, comments } = data;
  const config = statusConfig[pr.status];
  const unresolvedCount = comments.filter((c) => !c.comment.resolved).length;

  return (
    <main className="container pr-detail">
      <PRHeader
        pr={pr}
        config={config}
        requestingAI={requestingAI}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        onRequestAIReview={requestAIReview}
      />

      {/* Layout: Sidebar + Main */}
      <div className="pr-layout">
        <PRSidebar
          files={files}
          expandedFiles={expandedFiles}
          collapsedFolders={collapsedFolders}
          setCollapsedFolders={setCollapsedFolders}
          toggleFile={toggleFile}
          scrollToDiff={scrollToDiff}
          commits={data.commits}
          selectedCommit={selectedCommit}
          selectCommit={selectCommit}
          status={pr.status}
          reviewSummary={reviewSummary}
          setReviewSummary={setReviewSummary}
          submitting={submitting}
          submitReview={submitReview}
          unresolvedCount={unresolvedCount}
        />

        {/* Main Diff View */}
        <div className="pr-main">
          {diffLoading && (
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
              isExpanded={expandedFiles.has(file.path)}
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
        </div>
      </div>
    </main>
  );
}
