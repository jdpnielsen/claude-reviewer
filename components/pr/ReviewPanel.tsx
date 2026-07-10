'use client';

import { CheckCircle, XCircle } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

import { PullRequestStatus, ReviewAction } from '@/lib/enum';

interface ReviewPanelProps {
  status: PullRequestStatus;
  reviewSummary: string;
  setReviewSummary: Dispatch<SetStateAction<string>>;
  submitting: boolean;
  submitReview: (action: typeof ReviewAction.Approve | typeof ReviewAction.RequestChanges) => void;
}

export default function ReviewPanel({
  status,
  reviewSummary,
  setReviewSummary,
  submitting,
  submitReview,
}: ReviewPanelProps) {
  if (status === PullRequestStatus.Merged) return null;

  return (
    <div className="sidebar-section review-panel">
      <h3>Submit Review</h3>
      <textarea
        placeholder="Leave a comment (optional)"
        value={reviewSummary}
        onChange={(e) => setReviewSummary(e.target.value)}
        rows={3}
      />
      <div className="review-actions">
        <button
          className="btn-approve"
          onClick={() => submitReview(ReviewAction.Approve)}
          disabled={submitting}
        >
          <CheckCircle size={16} />
          Approve
        </button>
        <button
          className="btn-request-changes"
          onClick={() => submitReview(ReviewAction.RequestChanges)}
          disabled={submitting}
        >
          <XCircle size={16} />
          Request Changes
        </button>
      </div>
      {status === PullRequestStatus.Approved && (
        <div className="approved-notice">
          <CheckCircle size={16} />
          Approved - Ready for merge
        </div>
      )}
    </div>
  );
}
