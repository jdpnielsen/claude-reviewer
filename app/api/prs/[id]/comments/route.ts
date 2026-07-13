import { NextRequest, NextResponse } from 'next/server';

import {
  getPRByUuid,
  getCommentsWithReplies,
  addComment,
  resolveComment,
  updateCommentContent,
  deleteComment,
  addReply,
} from '@/lib/database';
import { CommentTargetType, LineType } from '@/lib/enum';
import { listCommits } from '@/lib/git';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/prs/[id]/comments - List comments with replies
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const unresolvedOnly = searchParams.get('unresolved') === 'true';

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    const commentsWithReplies = getCommentsWithReplies(id, unresolvedOnly);

    return NextResponse.json({ comments: commentsWithReplies });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/prs/[id]/comments - Add a comment or reply
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await req.json();
    const {
      filePath,
      lineNumber,
      endLineNumber,
      content,
      lineType,
      commentUuid,
      commitSha,
      targetType,
    } = body;

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    // If commentUuid is provided, this is a reply
    if (commentUuid) {
      if (!content) {
        return NextResponse.json({ error: 'Missing required field: content' }, { status: 400 });
      }
      const replyUuid = addReply(commentUuid, content);
      return NextResponse.json(
        {
          uuid: replyUuid,
          message: 'Reply added',
        },
        { status: 201 },
      );
    }

    const VALID_TARGET_TYPES = Object.values(CommentTargetType);
    if (targetType !== undefined && !VALID_TARGET_TYPES.includes(targetType)) {
      return NextResponse.json({ error: 'Invalid targetType' }, { status: 400 });
    }

    // A commit message comment has no file/line - it's anchored to a commit
    // as a whole, so commitSha is required (unlike a line comment, where it's
    // optional and NULL means "scoped to the cumulative view").
    if (targetType === CommentTargetType.CommitMessage) {
      if (!content) {
        return NextResponse.json({ error: 'Missing required field: content' }, { status: 400 });
      }
      if (typeof commitSha !== 'string' || !commitSha) {
        return NextResponse.json(
          { error: 'commitSha is required for a commit message comment' },
          { status: 400 },
        );
      }
      const commits = listCommits(pr.repo_path, pr.base_commit, pr.head_commit);
      if (!commits.some((c) => c.sha === commitSha)) {
        return NextResponse.json({ error: 'Unknown commit for this PR' }, { status: 400 });
      }

      const newCommentUuid = addComment(
        id,
        '',
        0,
        content,
        LineType.New,
        0,
        commitSha,
        CommentTargetType.CommitMessage,
      );

      return NextResponse.json(
        {
          uuid: newCommentUuid,
          message: 'Comment added',
        },
        { status: 201 },
      );
    }

    // Otherwise, this is a new line comment
    if (!filePath || lineNumber === undefined || !content) {
      return NextResponse.json(
        { error: 'Missing required fields: filePath, lineNumber, content' },
        { status: 400 },
      );
    }

    const VALID_LINE_TYPES = Object.values(LineType);
    if (lineType !== undefined && !VALID_LINE_TYPES.includes(lineType)) {
      return NextResponse.json({ error: 'Invalid lineType' }, { status: 400 });
    }

    if (endLineNumber !== undefined && endLineNumber < lineNumber) {
      return NextResponse.json({ error: 'endLineNumber must be >= lineNumber' }, { status: 400 });
    }

    const newCommentUuid = addComment(
      id,
      filePath,
      lineNumber,
      content,
      lineType || LineType.New,
      endLineNumber,
      typeof commitSha === 'string' ? commitSha : null,
    );

    return NextResponse.json(
      {
        uuid: newCommentUuid,
        message: 'Comment added',
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH /api/prs/[id]/comments - Resolve/unresolve or edit a comment
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { commentUuid, resolved, content } = body;

    if (!commentUuid) {
      return NextResponse.json({ error: 'Missing required field: commentUuid' }, { status: 400 });
    }

    let success = false;

    // Update content if provided
    if (content !== undefined) {
      success = updateCommentContent(commentUuid, content);
    }

    // Update resolved status if provided
    if (resolved !== undefined) {
      success = resolveComment(commentUuid, resolved);
    }

    if (!success) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/prs/[id]/comments - Delete a comment
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const commentUuid = searchParams.get('uuid');

    if (!commentUuid) {
      return NextResponse.json({ error: 'Missing comment uuid' }, { status: 400 });
    }

    const success = deleteComment(commentUuid);

    if (!success) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
