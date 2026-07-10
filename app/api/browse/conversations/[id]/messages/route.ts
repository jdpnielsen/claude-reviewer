import { NextRequest, NextResponse } from 'next/server';

import { getRepoConversationWithMessages, addRepoConversationMessage } from '@/lib/database';
import { AuthorKind } from '@/lib/enum';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/browse/conversations/[id]/messages - Get conversation with messages
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const conversation = getRepoConversationWithMessages(id);

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    return NextResponse.json(conversation);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/browse/conversations/[id]/messages - Add a message
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { content } = body;

    if (!content) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    const messageUuid = addRepoConversationMessage(id, content, AuthorKind.Human);
    return NextResponse.json({ uuid: messageUuid, success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
