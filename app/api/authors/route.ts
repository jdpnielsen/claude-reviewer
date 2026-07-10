import { NextRequest, NextResponse } from 'next/server';
import { listAuthors, getDefaultHumanAuthor, getDefaultAgentAuthor, createAuthor } from '@/lib/database';
import { getGitUserIdentity } from '@/lib/git';

// GET /api/authors - List all authors, annotated with default status
export async function GET() {
  try {
    const authors = listAuthors();
    const defaultHuman = getDefaultHumanAuthor();
    const defaultAgent = getDefaultAgentAuthor();
    const gitIdentity = getGitUserIdentity();

    return NextResponse.json({
      authors: authors.map((a) => ({
        ...a,
        isDefaultHuman: a.id === defaultHuman.id,
        isDefaultAgent: a.id === defaultAgent.id,
      })),
      gitSuggestion: gitIdentity.name || gitIdentity.email ? gitIdentity : null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/authors - Register a new author
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, kind, email } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (kind !== 'human' && kind !== 'agent') {
      return NextResponse.json({ error: "kind must be 'human' or 'agent'" }, { status: 400 });
    }

    const author = createAuthor(kind, name.trim(), email || null);
    return NextResponse.json({ author }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
