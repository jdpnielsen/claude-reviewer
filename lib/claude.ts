// Claude CLI integration for AI-powered code review operations
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface RunClaudeOptions {
  cwd?: string;
  allowEdits?: boolean;
  timeout?: number;
}

async function runClaude(prompt: string, options: RunClaudeOptions = {}): Promise<string> {
  const { cwd, allowEdits = false, timeout = 300000 } = options;

  return new Promise((resolve, reject) => {
    // Build command args
    const args = ['-p'];
    if (allowEdits) {
      // --dangerously-skip-permissions allows all tools without prompting
      args.unshift('--dangerously-skip-permissions');
    }

    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwd || process.cwd(),
      env: { ...process.env },
    });

    // Set timeout
    const timeoutId = setTimeout(() => {
      child.kill();
      reject(new Error('Claude CLI timed out'));
    }, timeout);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        console.error('Claude CLI error:', stderr);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    // Write prompt to stdin
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

interface FixComment {
  fileName: string;
  lineNumber: number;
  text: string;
}

export async function requestFixes(params: {
  repoInfo: string;
  diff: string;
  comments: FixComment[];
}) {
  const { diff, comments } = params;

  const formattedComments = comments
    .map((c) => `File: ${c.fileName}, Line: ${c.lineNumber}, Comment: ${c.text}`)
    .join('\n');

  const prompt = `You are an expert AI developer. I have some code changes and feedback. 
Please provide a unified diff patch that addresses the following comments.

<diff>
${diff}
</diff>

<comments>
${formattedComments}
</comments>

Output ONLY the unified diff patch. No prose, no explanations. 
If no changes are needed, output empty string.
Do not wrap the output in markdown code blocks if possible, or I will have to strip them.
Just header and diff content.`;

  const output = await runClaude(prompt);

  // Clean up output if wrapped in markdown
  return cleanDiffOutput(output);
}

export async function generatePRMetadata(diff: string) {
  const prompt = `Based on the following diff, generate a PR title and a concise description.

<diff>
${diff}
</diff>

Output in JSON format:
{
  "title": "...",
  "description": "..."
}`;

  const output = await runClaude(prompt);

  try {
    // Try to find JSON in the output
    const match = output.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (e) {
    console.error('Failed to parse JSON from Claude output', e);
  }

  return { title: 'PR Update', description: output };
}

function cleanDiffOutput(text: string): string {
  // Remove markdown code blocks if present
  let clean = text
    .replace(/^```diff\n/, '')
    .replace(/^```\n/, '')
    .replace(/```$/, '');
  // Also sometimes it adds "Here is the patch:" etc.
  // We expect a diff to start with "diff --git" or "---" or similar.
  // But strictly enforcing is hard.
  // However, `git apply` is picky.
  // Let's try to extract the patch block if mixed with text.

  // Simplistic approach: if it contains "diff --git", start from there.
  const diffStart = clean.indexOf('diff --git');
  if (diffStart !== -1) {
    clean = clean.substring(diffStart);
  } else {
    // maybe check for '--- a/'
    const fileCtx = clean.indexOf('--- a/');
    if (fileCtx !== -1) {
      clean = clean.substring(fileCtx);
    }
  }

  return clean.trim();
}

// Get file context around a specific line
function getFileContext(
  repoPath: string,
  filePath: string,
  lineNumber: number,
  contextLines: number = 10,
): string {
  try {
    const fullPath = path.join(repoPath, filePath);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    const start = Math.max(0, lineNumber - contextLines - 1);
    const end = Math.min(lines.length, lineNumber + contextLines);

    const contextParts: string[] = [];
    for (let i = start; i < end; i++) {
      const lineNum = i + 1;
      const prefix = lineNum === lineNumber ? '>>> ' : '    ';
      contextParts.push(`${prefix}${lineNum}: ${lines[i]}`);
    }

    return contextParts.join('\n');
  } catch (e) {
    return `[Error reading file: ${e}]`;
  }
}

export interface ConversationMessage {
  author: string;
  content: string;
}

export interface RespondToConversationParams {
  repoPath: string;
  filePath: string;
  lineNumber: number;
  messages: ConversationMessage[];
  allowEdits?: boolean;
}

export interface RespondToConversationResult {
  response: string;
  hasChanges: boolean;
  error?: string;
}

export async function respondToConversation(
  params: RespondToConversationParams,
): Promise<RespondToConversationResult> {
  const { repoPath, filePath, lineNumber, messages, allowEdits = true } = params;

  // Get file context
  const fileContext = getFileContext(repoPath, filePath, lineNumber);

  // Build conversation history
  const convHistory = messages.map((msg) => `[${msg.author}]: ${msg.content}`).join('\n');

  // Build prompt based on whether edits are allowed
  let prompt: string;
  if (allowEdits) {
    prompt = `You are Claude, an AI assistant helping with code review and discussion.

A user has started a conversation about a specific line of code. You have permission to edit files to address their feedback.

REPOSITORY: ${repoPath}
FILE: ${filePath}
LINE: ${lineNumber}

CODE CONTEXT (the >>> marks the line being discussed):
${fileContext}

CONVERSATION SO FAR:
${convHistory}

Please respond to the user's latest message. If they're requesting a change or fix:
1. Make the necessary edits to the file using the Edit tool
2. Briefly explain what you changed

If they're just asking a question, answer it. Be concise.`;
  } else {
    prompt = `You are Claude, an AI assistant helping with code review and discussion.

A user has started a conversation about a specific line of code. Please provide a helpful response.

FILE: ${filePath}
LINE: ${lineNumber}

CODE CONTEXT (the >>> marks the line being discussed):
${fileContext}

CONVERSATION SO FAR:
${convHistory}

Please respond to the user's latest message. Be concise but helpful.`;
  }

  try {
    const response = await runClaude(prompt, {
      cwd: repoPath,
      allowEdits,
      timeout: allowEdits ? 300000 : 120000, // 5 min for edits, 2 min otherwise
    });

    // Check if there are uncommitted changes (only if edits were allowed)
    let hasChanges = false;
    if (allowEdits) {
      try {
        const { execSync } = await import('child_process');
        const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf-8' });
        hasChanges = status.trim().length > 0;
      } catch {
        // Ignore git errors
      }
    }

    return { response, hasChanges };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    return { response: '', hasChanges: false, error: errorMessage };
  }
}

export interface CommitChangesParams {
  repoPath: string;
  message: string;
  push?: boolean;
}

export interface CommitChangesResult {
  success: boolean;
  commitHash?: string;
  error?: string;
}

export async function commitChanges(params: CommitChangesParams): Promise<CommitChangesResult> {
  const { repoPath, message, push = false } = params;

  try {
    const { execSync } = await import('child_process');

    // Stage all changes
    execSync('git add -A', { cwd: repoPath });

    // Commit with co-author
    const fullMessage = `${message}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`;
    execSync(`git commit -m "${fullMessage.replace(/"/g, '\\"')}"`, { cwd: repoPath });

    // Get commit hash
    const commitHash = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();

    // Push if requested
    if (push) {
      execSync('git push', { cwd: repoPath });
    }

    return { success: true, commitHash };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}
