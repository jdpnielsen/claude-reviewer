import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Types
export interface PullRequest {
  id: number;
  uuid: string;
  repo_path: string;
  title: string;
  description: string;
  base_ref: string;
  head_ref: string;
  base_commit: string;
  head_commit: string;
  status: 'pending' | 'approved' | 'changes_requested' | 'merged' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  uuid: string;
  pr_id: number;
  file_path: string;
  line_number: number;
  end_line_number: number;
  commit_sha: string | null;
  line_type: 'old' | 'new' | 'context';
  content: string;
  resolved: boolean;
  created_at: string;
}

export interface Review {
  id: number;
  pr_id: number;
  action: 'approve' | 'request_changes' | 'comment';
  summary: string | null;
  created_at: string;
}

export interface DiffSnapshot {
  id: number;
  pr_id: number;
  revision: number;
  diff_content: string;
  head_commit: string;
  created_at: string;
}

export interface CommentReply {
  id: number;
  uuid: string;
  comment_id: number;
  author: string;
  content: string;
  created_at: string;
}

// Repo-level conversations (independent of PRs)
export interface RepoConversation {
  id: number;
  uuid: string;
  repo_path: string;
  file_path: string;
  line_number: number;
  anchor_content: string | null;
  anchor_context_before: string | null;
  anchor_context_after: string | null;
  anchor_commit: string | null;
  status: 'active' | 'orphaned' | 'resolved';
  file_exists: boolean;
  current_line_number: number | null;
  created_at: string;
  updated_at: string;
}

export interface RepoConversationMessage {
  id: number;
  uuid: string;
  conversation_id: number;
  author: string;
  content: string;
  created_at: string;
}

export interface RepoConversationWithMessages {
  conversation: RepoConversation;
  messages: RepoConversationMessage[];
  message_count: number;
}

// Database path - shared with Python CLI
const DB_DIR = process.env.DATABASE_DIR || path.join(os.homedir(), '.claude-reviewer');
const DB_PATH = process.env.DATABASE_PATH || path.join(DB_DIR, 'data.db');

// Database instance with modification tracking
let db: Database.Database | null = null;
let dbMtime: number = 0;

/**
 * Get database connection, automatically reconnecting if the file was modified
 * by an external process (e.g., the Python CLI).
 */
export function getDatabase(): Database.Database {
  // Ensure directory exists
  fs.mkdirSync(DB_DIR, { recursive: true });

  // Check if database file was modified externally
  let currentMtime = 0;
  try {
    const stats = fs.statSync(DB_PATH);
    currentMtime = stats.mtimeMs;
  } catch {
    // File doesn't exist yet, will be created
  }

  // Reconnect if file was modified or no connection exists
  if (!db || (currentMtime > 0 && currentMtime !== dbMtime)) {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    // Initialize schema if needed
    initSchema(db);

    dbMtime = currentMtime || Date.now();
  }

  return db;
}

/**
 * Checkpoint WAL to ensure data is written to main db file.
 * This prevents corruption when Python CLI reads the database.
 */
function checkpoint(): void {
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    -- Pull Requests table
    CREATE TABLE IF NOT EXISTS pull_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        repo_path TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        base_ref TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        head_commit TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_pr_uuid ON pull_requests(uuid);
    CREATE INDEX IF NOT EXISTS idx_pr_repo ON pull_requests(repo_path);
    CREATE INDEX IF NOT EXISTS idx_pr_status ON pull_requests(status);

    -- Diff snapshots
    CREATE TABLE IF NOT EXISTS diff_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,
        diff_content TEXT NOT NULL,
        head_commit TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(pr_id, revision)
    );

    CREATE INDEX IF NOT EXISTS idx_diff_pr ON diff_snapshots(pr_id);

    -- Comments table
    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        end_line_number INTEGER,
        commit_sha TEXT,
        line_type TEXT DEFAULT 'new',
        content TEXT NOT NULL,
        resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr_id);
    CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(pr_id, file_path);

    -- Reviews table
    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        summary TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_id);

    -- Comment replies table
    CREATE TABLE IF NOT EXISTS comment_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        author TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_replies_comment ON comment_replies(comment_id);

    -- Repo-level conversations (independent of PRs)
    CREATE TABLE IF NOT EXISTS repo_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        repo_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        anchor_content TEXT,
        anchor_context_before TEXT,
        anchor_context_after TEXT,
        anchor_commit TEXT,
        status TEXT DEFAULT 'active',
        file_exists BOOLEAN DEFAULT TRUE,
        current_line_number INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_repo_conv_uuid ON repo_conversations(uuid);
    CREATE INDEX IF NOT EXISTS idx_repo_conv_repo ON repo_conversations(repo_path);
    CREATE INDEX IF NOT EXISTS idx_repo_conv_file ON repo_conversations(repo_path, file_path);
    CREATE INDEX IF NOT EXISTS idx_repo_conv_status ON repo_conversations(status);

    -- Repo conversation messages
    CREATE TABLE IF NOT EXISTS repo_conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        conversation_id INTEGER NOT NULL REFERENCES repo_conversations(id) ON DELETE CASCADE,
        author TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_rcm_conversation ON repo_conversation_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_rcm_uuid ON repo_conversation_messages(uuid);
  `);

  migrateCommentsEndLine(db);
  migrateCommentsCommitSha(db);
}

// Backfills end_line_number for databases created before multi-line comments
// existed. Runs on every getDatabase() reconnect, so it must stay cheap and
// idempotent, not just run-once-guarded.
function migrateCommentsEndLine(db: Database.Database): void {
  const columns = db.pragma('table_info(comments)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'end_line_number')) {
    try {
      db.exec('ALTER TABLE comments ADD COLUMN end_line_number INTEGER');
    } catch (e) {
      // A concurrent process (the Python CLI, or another reconnect) may have
      // added the column between the check above and this ALTER.
      if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
    }
  }
  db.exec('UPDATE comments SET end_line_number = line_number WHERE end_line_number IS NULL');
  checkpoint();
}

// Adds commit_sha for databases created before commit-by-commit review existed.
// NULL means "scoped to the cumulative view" - correct for every pre-existing
// comment, so unlike migrateCommentsEndLine, no backfill is needed.
function migrateCommentsCommitSha(db: Database.Database): void {
  const columns = db.pragma('table_info(comments)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'commit_sha')) {
    try {
      db.exec('ALTER TABLE comments ADD COLUMN commit_sha TEXT');
    } catch (e) {
      // A concurrent process (the Python CLI, or another reconnect) may have
      // added the column between the check above and this ALTER.
      if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
    }
  }
  checkpoint();
}

// Generate short UUID
function generateUuid(): string {
  return Math.random().toString(36).substring(2, 10);
}

// =============================================================================
// Pull Request Operations
// =============================================================================

export function createPR(
  repoPath: string,
  title: string,
  baseRef: string,
  headRef: string,
  baseCommit: string,
  headCommit: string,
  diff: string,
  description: string = ''
): string {
  const db = getDatabase();
  const uuid = generateUuid();

  const insertPR = db.prepare(`
    INSERT INTO pull_requests
    (uuid, repo_path, title, description, base_ref, head_ref, base_commit, head_commit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDiff = db.prepare(`
    INSERT INTO diff_snapshots (pr_id, revision, diff_content, head_commit)
    VALUES (?, 1, ?, ?)
  `);

  const transaction = db.transaction(() => {
    const result = insertPR.run(uuid, repoPath, title, description, baseRef, headRef, baseCommit, headCommit);
    insertDiff.run(result.lastInsertRowid, diff, headCommit);
  });

  transaction();
  checkpoint();
  return uuid;
}

export function getPRByUuid(uuid: string): PullRequest | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM pull_requests WHERE uuid = ?').get(uuid);
  return row as PullRequest | null;
}

export function getPRById(id: number): PullRequest | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM pull_requests WHERE id = ?').get(id);
  return row as PullRequest | null;
}

export function listPRs(options: {
  repoPath?: string;
  status?: string;
  limit?: number;
} = {}): PullRequest[] {
  const db = getDatabase();
  const { repoPath, status, limit = 50 } = options;

  let query = 'SELECT * FROM pull_requests WHERE 1=1';
  const params: (string | number)[] = [];

  if (repoPath) {
    query += ' AND repo_path = ?';
    params.push(repoPath);
  }

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params) as PullRequest[];
}

export function updatePRStatus(uuid: string, status: PullRequest['status']): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE pull_requests
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE uuid = ?
  `).run(status, uuid);
  checkpoint();
  return result.changes > 0;
}

export function getLatestDiff(uuid: string): string | null {
  const db = getDatabase();
  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(uuid) as { id: number } | undefined;
  if (!pr) return null;

  const row = db.prepare(`
    SELECT diff_content FROM diff_snapshots
    WHERE pr_id = ? ORDER BY revision DESC LIMIT 1
  `).get(pr.id) as { diff_content: string } | undefined;

  return row?.diff_content || null;
}

export function updatePRDiff(uuid: string, diff: string, headCommit: string): number {
  const db = getDatabase();

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(uuid) as { id: number } | undefined;
  if (!pr) throw new Error(`PR ${uuid} not found`);

  const maxRev = db.prepare(
    'SELECT MAX(revision) as max_rev FROM diff_snapshots WHERE pr_id = ?'
  ).get(pr.id) as { max_rev: number | null };

  const newRevision = (maxRev?.max_rev || 0) + 1;

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO diff_snapshots (pr_id, revision, diff_content, head_commit)
      VALUES (?, ?, ?, ?)
    `).run(pr.id, newRevision, diff, headCommit);

    db.prepare(`
      UPDATE pull_requests
      SET head_commit = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(headCommit, pr.id);
  });

  transaction();
  checkpoint();
  return newRevision;
}

// =============================================================================
// Comment Operations
// =============================================================================

export function addComment(
  prUuid: string,
  filePath: string,
  lineNumber: number,
  content: string,
  lineType: 'old' | 'new' | 'context' = 'new',
  endLineNumber: number = lineNumber,
  commitSha: string | null = null
): string {
  const db = getDatabase();
  const commentUuid = generateUuid();

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as { id: number } | undefined;
  if (!pr) throw new Error(`PR ${prUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO comments (uuid, pr_id, file_path, line_number, end_line_number, commit_sha, line_type, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(commentUuid, pr.id, filePath, lineNumber, endLineNumber, commitSha, lineType, content);

    db.prepare(
      'UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(pr.id);
  });

  transaction();
  checkpoint();
  return commentUuid;
}

export function getComments(
  prUuid: string,
  options: { unresolvedOnly?: boolean; filePath?: string } = {}
): Comment[] {
  const db = getDatabase();
  const { unresolvedOnly, filePath } = options;

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as { id: number } | undefined;
  if (!pr) return [];

  let query = 'SELECT * FROM comments WHERE pr_id = ?';
  const params: (number | string)[] = [pr.id];

  if (unresolvedOnly) {
    query += ' AND resolved = FALSE';
  }

  if (filePath) {
    query += ' AND file_path = ?';
    params.push(filePath);
  }

  query += ' ORDER BY file_path, line_number';

  return db.prepare(query).all(...params) as Comment[];
}

export function resolveComment(commentUuid: string, resolved: boolean = true): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE comments SET resolved = ? WHERE uuid = ?').run(resolved ? 1 : 0, commentUuid);
  checkpoint();
  return result.changes > 0;
}

export function updateCommentContent(commentUuid: string, content: string): boolean {
  const db = getDatabase();
  const result = db.prepare('UPDATE comments SET content = ? WHERE uuid = ?').run(content, commentUuid);
  checkpoint();
  return result.changes > 0;
}

export function deleteComment(commentUuid: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM comments WHERE uuid = ?').run(commentUuid);
  checkpoint();
  return result.changes > 0;
}

// =============================================================================
// Review Operations
// =============================================================================

export function submitReview(
  prUuid: string,
  action: 'approve' | 'request_changes',
  summary?: string
): boolean {
  const db = getDatabase();

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as { id: number } | undefined;
  if (!pr) throw new Error(`PR ${prUuid} not found`);

  const newStatus = action === 'approve' ? 'approved' : 'changes_requested';

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO reviews (pr_id, action, summary)
      VALUES (?, ?, ?)
    `).run(pr.id, action, summary || null);

    db.prepare(`
      UPDATE pull_requests
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newStatus, pr.id);
  });

  transaction();
  checkpoint();
  return true;
}

export function getReviews(prUuid: string): Review[] {
  const db = getDatabase();

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as { id: number } | undefined;
  if (!pr) return [];

  return db.prepare(`
    SELECT * FROM reviews WHERE pr_id = ? ORDER BY created_at DESC
  `).all(pr.id) as Review[];
}

// =============================================================================
// Comment Reply Operations
// =============================================================================

export function addReply(
  commentUuid: string,
  content: string,
  author: string = 'user'
): string {
  const db = getDatabase();
  const replyUuid = generateUuid();

  const comment = db.prepare('SELECT id, pr_id FROM comments WHERE uuid = ?').get(commentUuid) as { id: number; pr_id: number } | undefined;
  if (!comment) throw new Error(`Comment ${commentUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO comment_replies (uuid, comment_id, author, content)
      VALUES (?, ?, ?, ?)
    `).run(replyUuid, comment.id, author, content);

    db.prepare(
      'UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(comment.pr_id);
  });

  transaction();
  checkpoint();
  return replyUuid;
}

export function getReplies(commentUuid: string): CommentReply[] {
  const db = getDatabase();

  const comment = db.prepare('SELECT id FROM comments WHERE uuid = ?').get(commentUuid) as { id: number } | undefined;
  if (!comment) return [];

  return db.prepare(`
    SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at
  `).all(comment.id) as CommentReply[];
}

export function getCommentByUuid(commentUuid: string): Comment | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM comments WHERE uuid = ?').get(commentUuid);
  return row as Comment | null;
}

export function getCommentsWithReplies(prUuid: string, unresolvedOnly: boolean = false): Array<{ comment: Comment; replies: CommentReply[] }> {
  const comments = getComments(prUuid, { unresolvedOnly });
  return comments.map(comment => ({
    comment,
    replies: getReplies(comment.uuid)
  }));
}

// =============================================================================
// Repo Conversation Operations
// =============================================================================

export function createRepoConversation(
  repoPath: string,
  filePath: string,
  lineNumber: number,
  content: string,
  author: string = 'user',
  anchor?: {
    content: string;
    contextBefore: string;
    contextAfter: string;
    commit: string;
  }
): string {
  const db = getDatabase();
  const conversationUuid = generateUuid();
  const messageUuid = generateUuid();

  const transaction = db.transaction(() => {
    // Create conversation
    db.prepare(`
      INSERT INTO repo_conversations
      (uuid, repo_path, file_path, line_number, anchor_content, anchor_context_before, anchor_context_after, anchor_commit, current_line_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationUuid,
      repoPath,
      filePath,
      lineNumber,
      anchor?.content || null,
      anchor?.contextBefore || null,
      anchor?.contextAfter || null,
      anchor?.commit || null,
      lineNumber
    );

    // Get the conversation id
    const conv = db.prepare('SELECT id FROM repo_conversations WHERE uuid = ?').get(conversationUuid) as { id: number };

    // Create first message
    db.prepare(`
      INSERT INTO repo_conversation_messages (uuid, conversation_id, author, content)
      VALUES (?, ?, ?, ?)
    `).run(messageUuid, conv.id, author, content);
  });

  transaction();
  checkpoint();
  return conversationUuid;
}

export function getRepoConversation(uuid: string): RepoConversation | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM repo_conversations WHERE uuid = ?').get(uuid);
  return row as RepoConversation | null;
}

export function listRepoConversations(options: {
  repoPath: string;
  filePath?: string;
  status?: 'active' | 'orphaned' | 'resolved' | 'all';
  limit?: number;
} = { repoPath: '' }): RepoConversationWithMessages[] {
  const db = getDatabase();
  const { repoPath, filePath, status = 'all', limit = 100 } = options;

  let query = 'SELECT * FROM repo_conversations WHERE repo_path = ?';
  const params: (string | number)[] = [repoPath];

  if (filePath) {
    query += ' AND file_path = ?';
    params.push(filePath);
  }

  if (status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const conversations = db.prepare(query).all(...params) as RepoConversation[];

  return conversations.map(conv => {
    const messages = db.prepare(`
      SELECT * FROM repo_conversation_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `).all(conv.id) as RepoConversationMessage[];

    return {
      conversation: conv,
      messages,
      message_count: messages.length
    };
  });
}

export function getRepoConversationWithMessages(uuid: string): RepoConversationWithMessages | null {
  const db = getDatabase();
  const conv = db.prepare('SELECT * FROM repo_conversations WHERE uuid = ?').get(uuid) as RepoConversation | undefined;
  if (!conv) return null;

  const messages = db.prepare(`
    SELECT * FROM repo_conversation_messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(conv.id) as RepoConversationMessage[];

  return {
    conversation: conv,
    messages,
    message_count: messages.length
  };
}

export function addRepoConversationMessage(
  conversationUuid: string,
  content: string,
  author: string = 'user'
): string {
  const db = getDatabase();
  const messageUuid = generateUuid();

  const conv = db.prepare('SELECT id FROM repo_conversations WHERE uuid = ?').get(conversationUuid) as { id: number } | undefined;
  if (!conv) throw new Error(`Conversation ${conversationUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO repo_conversation_messages (uuid, conversation_id, author, content)
      VALUES (?, ?, ?, ?)
    `).run(messageUuid, conv.id, author, content);

    db.prepare(`
      UPDATE repo_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(conv.id);
  });

  transaction();
  checkpoint();
  return messageUuid;
}

export function updateRepoConversationStatus(
  uuid: string,
  status: 'active' | 'orphaned' | 'resolved'
): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE repo_conversations
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE uuid = ?
  `).run(status, uuid);
  checkpoint();
  return result.changes > 0;
}

export function updateRepoConversationAnchor(
  uuid: string,
  currentLineNumber: number | null,
  fileExists: boolean = true
): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE repo_conversations
    SET current_line_number = ?, file_exists = ?, updated_at = CURRENT_TIMESTAMP
    WHERE uuid = ?
  `).run(currentLineNumber, fileExists ? 1 : 0, uuid);
  checkpoint();
  return result.changes > 0;
}

export function getConversationCountsByFile(repoPath: string): Record<string, number> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT file_path, COUNT(*) as count
    FROM repo_conversations
    WHERE repo_path = ? AND status != 'resolved'
    GROUP BY file_path
  `).all(repoPath) as Array<{ file_path: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.file_path] = row.count;
  }
  return counts;
}

export function deleteRepoConversation(uuid: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM repo_conversations WHERE uuid = ?').run(uuid);
  checkpoint();
  return result.changes > 0;
}

// =============================================================================
// Utility
// =============================================================================

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
