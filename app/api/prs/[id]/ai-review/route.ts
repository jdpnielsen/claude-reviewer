import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { getPRByUuid, addComment, getLatestDiff } from '@/lib/database';
import { listCommits, blameCommit } from '@/lib/git';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ReviewComment {
  file_path: string;
  line_number: number;
  content: string;
}

async function runClaudeWithContext(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use claude CLI with -p for print mode, running in the repo directory for full context
    const child = spawn('claude', ['-p', '--allowedTools', 'Read,Grep,Glob,Bash'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('Claude CLI error:', stderr);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// POST /api/prs/[id]/ai-review - Request AI review with full codebase context
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const pr = getPRByUuid(id);
    if (!pr) {
      return NextResponse.json({ error: 'PR not found' }, { status: 404 });
    }

    const diff = getLatestDiff(id);
    if (!diff) {
      return NextResponse.json({ error: 'Diff not found' }, { status: 404 });
    }

    const prompt = `You are reviewing a pull request. You have full access to read and search the codebase to understand context.

IMPORTANT: You MUST use your tools (Read, Grep, Glob) to explore the codebase and understand:
1. The existing code patterns and architecture
2. How the changed files relate to other parts of the codebase
3. Whether the changes follow established conventions

Here is the diff being reviewed:

<diff>
${diff}
</diff>

After exploring the codebase, provide your review as a JSON array of specific, actionable comments. Each comment should:
- Reference specific lines in the diff
- Be based on understanding of the broader codebase context
- Suggest concrete improvements or highlight real issues
- NOT ask generic questions - provide actual review feedback

Format your response as ONLY a JSON array (no other text):
[
  {
    "file_path": "path/to/file.ts",
    "line_number": 42,
    "content": "Your specific review comment here"
  }
]

If the code looks good and you have no comments, return an empty array: []

Do NOT include explanatory text outside the JSON array.`;

    const response = await runClaudeWithContext(prompt, pr.repo_path);

    // Parse the JSON response
    let comments: ReviewComment[] = [];
    try {
      // Find JSON array in response
      const match = response.match(/\[[\s\S]*\]/);
      if (match) {
        comments = JSON.parse(match[0]);
      }
    } catch (parseError) {
      console.error('Failed to parse AI review response:', parseError);
      console.error('Raw response:', response);
      return NextResponse.json({
        error: 'Failed to parse AI review response',
        raw: response
      }, { status: 500 });
    }

    // Attribute each comment to whichever commit last touched that line,
    // restricted to commits within this PR's range - an unrestricted blame
    // match means the line predates the PR, so it stays cumulative-scoped.
    const commits = listCommits(pr.repo_path, pr.base_commit, pr.head_commit);
    const commitShas = new Set(commits.map((c) => c.sha));

    const addedComments: string[] = [];
    for (const comment of comments) {
      if (comment.file_path && comment.line_number && comment.content) {
        const blamedSha = blameCommit(pr.repo_path, pr.head_commit, comment.file_path, comment.line_number);
        const commitSha = blamedSha && commitShas.has(blamedSha) ? blamedSha : null;
        const uuid = addComment(
          id,
          comment.file_path,
          comment.line_number,
          comment.content,
          'new',
          comment.line_number,
          commitSha
        );
        addedComments.push(uuid);
      }
    }

    return NextResponse.json({
      success: true,
      comments_added: addedComments.length,
      comment_uuids: addedComments
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('AI Review error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
