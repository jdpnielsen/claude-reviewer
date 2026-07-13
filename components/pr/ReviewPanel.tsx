'use client';

import { useClickOutside, useHotkeys } from '@mantine/hooks';
import { CheckCircle, ChevronDown } from 'lucide-react';
import { useState } from 'react';
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
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<
    typeof ReviewAction.Approve | typeof ReviewAction.RequestChanges
  >(ReviewAction.Approve);

  const ref = useClickOutside(() => setOpen(false));
  useHotkeys([['Escape', () => setOpen(false)]]);

  if (status === PullRequestStatus.Merged) return null;

  const handleSubmit = () => {
    submitReview(action);
    setOpen(false);
  };

  return (
    <div className="review-dropdown" ref={ref}>
      {status === PullRequestStatus.Approved && (
        <span className="approved-notice">
          <CheckCircle size={14} />
          Approved
        </span>
      )}
      <button className="review-dropdown-trigger" onClick={() => setOpen((o) => !o)}>
        Submit Review
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="review-dropdown-panel">
          <div className="review-dropdown-header">
            <h4>Finish your review</h4>
          </div>
          <textarea
            className="review-dropdown-textarea"
            placeholder="Leave a comment"
            value={reviewSummary}
            onChange={(e) => setReviewSummary(e.target.value)}
            rows={4}
            ref={(el) => el?.focus()}
          />
          <div className="review-dropdown-options">
            <label
              className={`review-option ${action === ReviewAction.Approve ? 'selected' : ''}`}
              aria-label="Approve"
            >
              <input
                type="radio"
                name="review-action"
                checked={action === ReviewAction.Approve}
                onChange={() => setAction(ReviewAction.Approve)}
              />
              <span>
                <strong>Approve</strong>
                <small>Submit feedback and approve merging these changes.</small>
              </span>
            </label>
            <label
              className={`review-option ${action === ReviewAction.RequestChanges ? 'selected' : ''}`}
              aria-label="Request changes"
            >
              <input
                type="radio"
                name="review-action"
                checked={action === ReviewAction.RequestChanges}
                onChange={() => setAction(ReviewAction.RequestChanges)}
              />
              <span>
                <strong>Request changes</strong>
                <small>Submit feedback suggesting changes.</small>
              </span>
            </label>
          </div>
          <div className="review-dropdown-footer">
            <button className="review-dropdown-cancel" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className={action === ReviewAction.Approve ? 'btn-approve' : 'btn-request-changes'}
              onClick={handleSubmit}
              disabled={submitting}
            >
              Submit review
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
