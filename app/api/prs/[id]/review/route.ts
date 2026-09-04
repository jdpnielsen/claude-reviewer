import { NextRequest, NextResponse } from 'next/server';

import { addComment, getPRByUuid, getComments, submitReview, getReviews } from '@/lib/database';
import {
  CommentResolutionMode,
  CommentTargetType,
  LineType,
  PullRequestStatus,
  ReviewAction,
} from '@/lib/enum';
import { inferPreferences, appendToClaudeMd } from '@/lib/preferences';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/prs/[id]/review - Get review history
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    const reviews = getReviews(id);

    return NextResponse.json({ reviews });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/prs/[id]/review - Submit a review (approve/request_changes)
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { action, summary } = body;

    if (!action || ![ReviewAction.Approve, ReviewAction.RequestChanges].includes(action)) {
      return NextResponse.json(
        { error: 'Invalid action. Must be "approve" or "request_changes"' },
        { status: 400 },
      );
    }

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    // Submit the review
    submitReview(id, action, summary);

    // If changes were requested, try to infer preferences from comments. Read
    // before the review-summary comment below is created, so that comment
    // (not real line-level feedback - it has no file/line of its own) never
    // pollutes the prompt.
    if (action === ReviewAction.RequestChanges) {
      const comments = getComments(id, { unresolvedOnly: true });

      if (comments.length > 0) {
        try {
          // Infer preferences and append to CLAUDE.md
          const preferences = await inferPreferences(comments, pr.repo_path);
          if (preferences && preferences.length > 0) {
            await appendToClaudeMd(pr.repo_path, preferences);
          }
        } catch (e) {
          // Don't fail the review if preference inference fails
          console.error('Failed to infer preferences:', e);
        }
      }
    }

    // Any review with a summary is otherwise invisible outside the reviews
    // table - it never shows in the Conversation tab and has no uuid a reply
    // can target. Mirroring it into a real comment gives it both for free: it
    // shows up alongside everything else and Claude can `reply` to it, and it
    // can be resolved exactly like any other thread. review_action records
    // which review produced it, so the UI can label it "Approved" vs
    // "Changes requested" instead of assuming one or the other.
    if (typeof summary === 'string' && summary.trim()) {
      addComment(
        id,
        '',
        0,
        summary,
        LineType.New,
        0,
        null,
        CommentTargetType.ReviewSummary,
        null,
        null,
        null,
        // A review summary isn't the kind of feedback resolution mode is
        // about (it's a whole-review verdict, not a per-line request), so it
        // stays on the default.
        CommentResolutionMode.Fix,
        action,
      );
    }

    const newStatus =
      action === ReviewAction.Approve
        ? PullRequestStatus.Approved
        : PullRequestStatus.ChangesRequested;

    return NextResponse.json({
      success: true,
      status: newStatus,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
