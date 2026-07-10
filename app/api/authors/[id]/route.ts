import { NextRequest, NextResponse } from 'next/server';

import { updateAuthor, deleteAuthor } from '@/lib/database';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// PATCH /api/authors/[id] - Update name/email
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await req.json();
    const author = updateAuthor(Number(id), { name: body.name, email: body.email });
    return NextResponse.json({ author });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE /api/authors/[id] - Remove an author (blocked if referenced or default)
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    deleteAuthor(Number(id));
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
