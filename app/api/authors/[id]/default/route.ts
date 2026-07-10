import { NextRequest, NextResponse } from 'next/server';
import { setDefaultAuthor } from '@/lib/database';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/authors/[id]/default - Make this author the default for its kind
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    setDefaultAuthor(Number(id));
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
