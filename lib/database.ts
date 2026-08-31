import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import {
  AuthorKind,
  CommentRelocationStatus,
  CommentTargetType,
  ConversationStatus,
  LineType,
  PullRequestStatus,
  ReviewAction,
} from './enum';
import { getGitUserIdentity } from './git';

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
  status: PullRequestStatus;
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
  target_type: CommentTargetType;
  line_type: LineType;
  content: string;
  resolved: boolean;
  anchor_content: string | null;
  anchor_context_before: string | null;
  anchor_context_after: string | null;
  status: CommentRelocationStatus;
  created_at: string;
  // The opposite side's range, when this comment spans an adjacent
  // deleted+added line pair (shift-click across the gutter from one side to
  // the other) - line_number/end_line_number stay New-side, this is Old-side.
  // NULL for an ordinary single-side comment. Not independently
  // content-anchored: relocateComments() shifts it by the same delta as the
  // primary (New-side) range rather than re-searching for it on its own blob.
  paired_line_number: number | null;
  paired_end_line_number: number | null;
}

// Durable "this SHA used to mean that SHA" mapping for a PR, built up by
// relocateComments() on every sync. Lets a stale `?commit=<old sha>` link
// (and any comment's commit_sha) resolve to where that commit ended up after
// a rebase/amend/force-push, without walking a chain of intermediate syncs -
// see upsertCommitRelocation, which collapses chains eagerly on write.
export interface CommitRelocation {
  id: number;
  pr_id: number;
  old_sha: string;
  new_sha: string;
  created_at: string;
}

export interface Review {
  id: number;
  pr_id: number;
  action: ReviewAction;
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
  author_id: number;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}

export interface Author {
  id: number;
  kind: AuthorKind;
  name: string;
  email: string | null;
  created_at: string;
  updated_at: string;
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
  status: ConversationStatus;
  file_exists: boolean;
  current_line_number: number | null;
  created_at: string;
  updated_at: string;
}

export interface RepoConversationMessage {
  id: number;
  uuid: string;
  conversation_id: number;
  author_id: number;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}

export interface RepoConversationWithMessages {
  conversation: RepoConversation;
  messages: RepoConversationMessage[];
  message_count: number;
}

// Database path - shared with Python CLI.
// Resolved lazily (not as a module-level const) because ESM import hoisting
// means any code that sets process.env.DATABASE_DIR/DATABASE_PATH before an
// `import ... from './database'` statement runs AFTER this module's top-level
// code has already executed - a frozen top-level const would permanently miss
// that override and silently fall back to the real ~/.claude-reviewer path.
function getDbDir(): string {
  return process.env.DATABASE_DIR || path.join(os.homedir(), '.claude-reviewer');
}

function getDbPath(): string {
  return process.env.DATABASE_PATH || path.join(getDbDir(), 'data.db');
}

// Database instance with modification tracking
let db: Database.Database | null = null;
let dbMtime: number = 0;

/**
 * Get database connection, automatically reconnecting if the file was modified
 * by an external process (e.g., the Python CLI).
 */
export function getDatabase(): Database.Database {
  // Ensure directory exists
  fs.mkdirSync(getDbDir(), { recursive: true });

  // Check if database file was modified externally
  let currentMtime = 0;
  try {
    const stats = fs.statSync(getDbPath());
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

    db = new Database(getDbPath());
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
  rebuildReplyTablesIfPreAuthors(db);

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
        target_type TEXT NOT NULL DEFAULT 'line',
        line_type TEXT DEFAULT 'new',
        content TEXT NOT NULL,
        resolved BOOLEAN DEFAULT FALSE,
        anchor_content TEXT,
        anchor_context_before TEXT,
        anchor_context_after TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr_id);
    CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(pr_id, file_path);

    -- Durable historical-SHA -> current-SHA mapping per PR, populated by
    -- relocateComments() on every sync. See CommitRelocation above.
    CREATE TABLE IF NOT EXISTS commit_relocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        old_sha TEXT NOT NULL,
        new_sha TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(pr_id, old_sha)
    );

    CREATE INDEX IF NOT EXISTS idx_commit_relocations_pr ON commit_relocations(pr_id);

    -- Reviews table
    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        summary TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_id);

    -- Authors table (human + agent identities)
    CREATE TABLE IF NOT EXISTS authors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_authors_kind ON authors(kind);

    -- Settings table (default-author pointers only, not a generic KV store)
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Comment replies table
    CREATE TABLE IF NOT EXISTS comment_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES authors(id),
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
        author_id INTEGER NOT NULL REFERENCES authors(id),
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_rcm_conversation ON repo_conversation_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_rcm_uuid ON repo_conversation_messages(uuid);
  `);

  seedAuthors(db);
  migrateCommentsEndLine(db);
  migrateCommentsCommitSha(db);
  migrateCommentsTargetType(db);
  migrateCommentsAnchor(db);
  migrateCommentsStatus(db);
  migrateCommentsPairedRange(db);
}

// A database created before the authors table existed has comment_replies/
// repo_conversation_messages in the old author-TEXT-column shape. Rather than
// backfill (existing reply data is not preserved - see the design spec),
// drop and let the CREATE TABLE IF NOT EXISTS block below recreate both
// tables in the new author_id-based shape.
function rebuildReplyTablesIfPreAuthors(db: Database.Database): void {
  const authorsExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'authors'`)
    .get();
  if (!authorsExists) {
    db.exec('DROP TABLE IF EXISTS comment_replies');
    db.exec('DROP TABLE IF EXISTS repo_conversation_messages');
  }
}

// Seeds the one-time default agent ('claude') and default human (from git
// config, if available) rows, plus the settings pointers to them. Guarded so
// it only inserts rows/pointers that don't exist yet - safe to call on every
// getDatabase() reconnect.
function seedAuthors(db: Database.Database): void {
  let agent = db.prepare(`SELECT id FROM authors WHERE kind = 'agent'`).get() as
    | { id: number }
    | undefined;
  if (!agent) {
    const result = db.prepare(`INSERT INTO authors (kind, name) VALUES ('agent', 'claude')`).run();
    agent = { id: result.lastInsertRowid as number };
  }

  let human = db.prepare(`SELECT id FROM authors WHERE kind = 'human'`).get() as
    | { id: number }
    | undefined;
  if (!human) {
    const identity = getGitUserIdentity();
    const result = db
      .prepare(`INSERT INTO authors (kind, name, email) VALUES ('human', ?, ?)`)
      .run(identity.name || 'reviewer', identity.email);
    human = { id: result.lastInsertRowid as number };
  }

  const hasDefaultAgent = db
    .prepare(`SELECT 1 FROM settings WHERE key = 'default_agent_author_id'`)
    .get();
  if (!hasDefaultAgent) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('default_agent_author_id', ?)`).run(
      String(agent.id),
    );
  }

  const hasDefaultHuman = db
    .prepare(`SELECT 1 FROM settings WHERE key = 'default_human_author_id'`)
    .get();
  if (!hasDefaultHuman) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('default_human_author_id', ?)`).run(
      String(human.id),
    );
  }
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

// Adds target_type for databases created before commit-message review existed.
// DEFAULT 'line' backfills every existing row correctly - every pre-existing
// comment is, in fact, a line comment.
function migrateCommentsTargetType(db: Database.Database): void {
  const columns = db.pragma('table_info(comments)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'target_type')) {
    try {
      db.exec("ALTER TABLE comments ADD COLUMN target_type TEXT NOT NULL DEFAULT 'line'");
    } catch (e) {
      // A concurrent process (the Python CLI, or another reconnect) may have
      // added the column between the check above and this ALTER.
      if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
    }
  }
  checkpoint();
}

// Adds the content-anchor columns for databases created before comment
// relocation existed. NULL on every pre-existing row - relocateComments()
// treats a NULL anchor as "can't content-relocate this one" and falls back to
// commit_sha-only relocation for it.
function migrateCommentsAnchor(db: Database.Database): void {
  const columns = db.pragma('table_info(comments)') as Array<{ name: string }>;
  for (const column of ['anchor_content', 'anchor_context_before', 'anchor_context_after']) {
    if (!columns.some((c) => c.name === column)) {
      try {
        db.exec(`ALTER TABLE comments ADD COLUMN ${column} TEXT`);
      } catch (e) {
        // A concurrent process (the Python CLI, or another reconnect) may have
        // added the column between the check above and this ALTER.
        if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
      }
    }
  }
  checkpoint();
}

// Adds status for databases created before comment relocation existed.
// DEFAULT 'active' is correct for every pre-existing row.
function migrateCommentsStatus(db: Database.Database): void {
  const columns = db.pragma('table_info(comments)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'status')) {
    try {
      db.exec("ALTER TABLE comments ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    } catch (e) {
      // A concurrent process (the Python CLI, or another reconnect) may have
      // added the column between the check above and this ALTER.
      if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
    }
  }
  checkpoint();
}

// Adds the opposite-side range for databases created before cross-side
// (deleted+added adjacent pair) comments existed. NULL on every pre-existing
// row - every pre-existing comment is, in fact, single-sided.
function migrateCommentsPairedRange(db: Database.Database): void {
  const columns = db.pragma('table_info(comments)') as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));
  for (const column of ['paired_line_number', 'paired_end_line_number']) {
    if (!existing.has(column)) {
      try {
        db.exec(`ALTER TABLE comments ADD COLUMN ${column} INTEGER`);
      } catch (e) {
        // A concurrent process (the Python CLI, or another reconnect) may have
        // added the column between the check above and this ALTER.
        if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
      }
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
  description: string = '',
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
    const result = insertPR.run(
      uuid,
      repoPath,
      title,
      description,
      baseRef,
      headRef,
      baseCommit,
      headCommit,
    );
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

export function listPRs(
  options: {
    repoPath?: string;
    status?: string;
    limit?: number;
    excludeClosed?: boolean;
  } = {},
): PullRequest[] {
  const db = getDatabase();
  const { repoPath, status, limit = 50, excludeClosed = false } = options;

  let query = 'SELECT * FROM pull_requests WHERE 1=1';
  const params: (string | number)[] = [];

  if (repoPath) {
    query += ' AND repo_path = ?';
    params.push(repoPath);
  }

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  } else if (excludeClosed) {
    // The web UI's default "All" filter hides closed PRs; they stay reachable
    // via the explicit "Closed" filter (which sets `status` above). An explicit
    // status always wins, so this only applies to the unfiltered listing.
    query += ' AND status != ?';
    params.push(PullRequestStatus.Closed);
  }

  query += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params) as PullRequest[];
}

export function updatePRStatus(uuid: string, status: PullRequest['status']): boolean {
  const db = getDatabase();
  const result = db
    .prepare(`
    UPDATE pull_requests
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE uuid = ?
  `)
    .run(status, uuid);
  checkpoint();
  return result.changes > 0;
}

/**
 * Delete a PR and everything hanging off it (diff snapshots, comments and
 * their replies, reviews, commit relocations), matching the CLI's
 * `claude-reviewer delete`. The children go via `ON DELETE CASCADE` on their
 * `pr_id` foreign keys, which the `foreign_keys = ON` pragma in getDatabase()
 * is what actually enforces - without it this would silently orphan them.
 *
 * Touches only the database, deliberately: this is the escape hatch for a PR
 * whose repo path no longer exists, so it must not depend on git.
 */
export function deletePR(uuid: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM pull_requests WHERE uuid = ?').run(uuid);
  checkpoint();
  return result.changes > 0;
}

export function getLatestDiff(uuid: string): string | null {
  const db = getDatabase();
  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(uuid) as
    | { id: number }
    | undefined;
  if (!pr) return null;

  const row = db
    .prepare(`
    SELECT diff_content FROM diff_snapshots
    WHERE pr_id = ? ORDER BY revision DESC LIMIT 1
  `)
    .get(pr.id) as { diff_content: string } | undefined;

  return row?.diff_content || null;
}

export interface UpdatePRDiffResult {
  revision: number;
  // The base/head commits pull_requests held just before this call
  // overwrote them - callers pass these into relocateComments() alongside
  // the new commits to re-anchor anything keyed to the old SHAs.
  oldBaseCommit: string;
  oldHeadCommit: string;
}

export function updatePRDiff(
  uuid: string,
  diff: string,
  headCommit: string,
  baseCommit: string,
): UpdatePRDiffResult {
  const db = getDatabase();

  const pr = db
    .prepare('SELECT id, base_commit, head_commit FROM pull_requests WHERE uuid = ?')
    .get(uuid) as { id: number; base_commit: string; head_commit: string } | undefined;
  if (!pr) throw new Error(`PR ${uuid} not found`);

  const maxRev = db
    .prepare('SELECT MAX(revision) as max_rev FROM diff_snapshots WHERE pr_id = ?')
    .get(pr.id) as { max_rev: number | null };

  const newRevision = (maxRev?.max_rev || 0) + 1;

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO diff_snapshots (pr_id, revision, diff_content, head_commit)
      VALUES (?, ?, ?, ?)
    `).run(pr.id, newRevision, diff, headCommit);

    db.prepare(`
      UPDATE pull_requests
      SET head_commit = ?, base_commit = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(headCommit, baseCommit, pr.id);
  });

  transaction();
  checkpoint();
  return { revision: newRevision, oldBaseCommit: pr.base_commit, oldHeadCommit: pr.head_commit };
}

// =============================================================================
// Comment Operations
// =============================================================================

export interface CommentAnchor {
  content: string;
  contextBefore: string;
  contextAfter: string;
}

export function addComment(
  prUuid: string,
  filePath: string,
  lineNumber: number,
  content: string,
  lineType: LineType = LineType.New,
  endLineNumber: number = lineNumber,
  commitSha: string | null = null,
  targetType: CommentTargetType = CommentTargetType.Line,
  anchor: CommentAnchor | null = null,
  pairedLineNumber: number | null = null,
  pairedEndLineNumber: number | null = null,
): string {
  const db = getDatabase();
  const commentUuid = generateUuid();

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as
    | { id: number }
    | undefined;
  if (!pr) throw new Error(`PR ${prUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO comments (
        uuid, pr_id, file_path, line_number, end_line_number, commit_sha, target_type, line_type,
        content, anchor_content, anchor_context_before, anchor_context_after,
        paired_line_number, paired_end_line_number
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      commentUuid,
      pr.id,
      filePath,
      lineNumber,
      endLineNumber,
      commitSha,
      targetType,
      lineType,
      content,
      anchor?.content ?? null,
      anchor?.contextBefore ?? null,
      anchor?.contextAfter ?? null,
      pairedLineNumber,
      pairedEndLineNumber,
    );

    db.prepare('UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pr.id);
  });

  transaction();
  checkpoint();
  return commentUuid;
}

export function getComments(
  prUuid: string,
  options: { unresolvedOnly?: boolean; filePath?: string } = {},
): Comment[] {
  const db = getDatabase();
  const { unresolvedOnly, filePath } = options;

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as
    | { id: number }
    | undefined;
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
  const result = db
    .prepare('UPDATE comments SET resolved = ? WHERE uuid = ?')
    .run(resolved ? 1 : 0, commentUuid);
  checkpoint();
  return result.changes > 0;
}

export function updateCommentContent(commentUuid: string, content: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare('UPDATE comments SET content = ? WHERE uuid = ?')
    .run(content, commentUuid);
  checkpoint();
  return result.changes > 0;
}

export function deleteComment(commentUuid: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM comments WHERE uuid = ?').run(commentUuid);
  checkpoint();
  return result.changes > 0;
}

// A relocated comment's new coordinates, computed by relocateComments() and
// applied here in one shot. Always the full set of columns (not a partial
// update) - the caller always resolves a definite value (even "unchanged")
// for each, so there's no ambiguity about which fields a given call touches.
export interface CommentRelocationUpdate {
  commentId: number;
  commitSha: string | null;
  filePath: string;
  lineNumber: number;
  endLineNumber: number;
  status: CommentRelocationStatus;
  pairedLineNumber: number | null;
  pairedEndLineNumber: number | null;
}

export function applyCommentRelocations(relocations: CommentRelocationUpdate[]): void {
  if (relocations.length === 0) return;
  const db = getDatabase();

  const transaction = db.transaction(() => {
    for (const r of relocations) {
      db.prepare(`
        UPDATE comments
        SET commit_sha = ?, file_path = ?, line_number = ?, end_line_number = ?, status = ?,
            paired_line_number = ?, paired_end_line_number = ?
        WHERE id = ?
      `).run(
        r.commitSha,
        r.filePath,
        r.lineNumber,
        r.endLineNumber,
        r.status,
        r.pairedLineNumber,
        r.pairedEndLineNumber,
        r.commentId,
      );
    }
  });

  transaction();
  checkpoint();
}

// Upserts an old-SHA -> new-SHA mapping for a PR, collapsing chains eagerly:
// any existing row whose new_sha *was* oldSha (from an earlier sync) is
// rewritten to point straight at newSha, so a link from several syncs ago
// still resolves in a single indexed lookup (see lookupCommitRelocation)
// instead of needing to walk a chain.
export function upsertCommitRelocation(prUuid: string, oldSha: string, newSha: string): void {
  const db = getDatabase();

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as
    | { id: number }
    | undefined;
  if (!pr) throw new Error(`PR ${prUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE commit_relocations SET new_sha = ? WHERE pr_id = ? AND new_sha = ?
    `).run(newSha, pr.id, oldSha);

    db.prepare(`
      INSERT INTO commit_relocations (pr_id, old_sha, new_sha)
      VALUES (?, ?, ?)
      ON CONFLICT(pr_id, old_sha) DO UPDATE SET new_sha = excluded.new_sha
    `).run(pr.id, oldSha, newSha);
  });

  transaction();
  checkpoint();
}

// Resolves a historical SHA (from a stale `?commit=` link, or a comment's
// commit_sha) to whatever it currently maps to, if this PR has ever seen a
// sync that rewrote it. Null means either the SHA is still current or was
// never part of this PR - the caller can't distinguish those from this alone.
export function lookupCommitRelocation(prUuid: string, oldSha: string): string | null {
  const db = getDatabase();

  const row = db
    .prepare(`
    SELECT cr.new_sha as new_sha
    FROM commit_relocations cr
    JOIN pull_requests pr ON pr.id = cr.pr_id
    WHERE pr.uuid = ? AND cr.old_sha = ?
  `)
    .get(prUuid, oldSha) as { new_sha: string } | undefined;

  return row?.new_sha ?? null;
}

// =============================================================================
// Review Operations
// =============================================================================

export function submitReview(
  prUuid: string,
  action: typeof ReviewAction.Approve | typeof ReviewAction.RequestChanges,
  summary?: string,
): boolean {
  const db = getDatabase();

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as
    | { id: number }
    | undefined;
  if (!pr) throw new Error(`PR ${prUuid} not found`);

  const newStatus =
    action === ReviewAction.Approve
      ? PullRequestStatus.Approved
      : PullRequestStatus.ChangesRequested;

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

  const pr = db.prepare('SELECT id FROM pull_requests WHERE uuid = ?').get(prUuid) as
    | { id: number }
    | undefined;
  if (!pr) return [];

  return db
    .prepare(`
    SELECT * FROM reviews WHERE pr_id = ? ORDER BY created_at DESC
  `)
    .all(pr.id) as Review[];
}

// =============================================================================
// Comment Reply Operations
// =============================================================================

export function addReply(commentUuid: string, content: string): string {
  const db = getDatabase();
  const replyUuid = generateUuid();
  const authorId = getDefaultHumanAuthor().id;

  const comment = db.prepare('SELECT id, pr_id FROM comments WHERE uuid = ?').get(commentUuid) as
    | { id: number; pr_id: number }
    | undefined;
  if (!comment) throw new Error(`Comment ${commentUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO comment_replies (uuid, comment_id, author_id, content)
      VALUES (?, ?, ?, ?)
    `).run(replyUuid, comment.id, authorId, content);

    db.prepare('UPDATE pull_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      comment.pr_id,
    );
  });

  transaction();
  checkpoint();
  return replyUuid;
}

export function getReplies(commentUuid: string): CommentReply[] {
  const db = getDatabase();

  const comment = db.prepare('SELECT id FROM comments WHERE uuid = ?').get(commentUuid) as
    | { id: number }
    | undefined;
  if (!comment) return [];

  return db
    .prepare(`
    SELECT cr.id, cr.uuid, cr.comment_id, cr.author_id, a.name AS author, a.kind AS author_kind, cr.content, cr.created_at
    FROM comment_replies cr
    JOIN authors a ON a.id = cr.author_id
    WHERE cr.comment_id = ?
    ORDER BY cr.created_at
  `)
    .all(comment.id) as CommentReply[];
}

export function getCommentByUuid(commentUuid: string): Comment | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM comments WHERE uuid = ?').get(commentUuid);
  return row as Comment | null;
}

export function getCommentsWithReplies(
  prUuid: string,
  unresolvedOnly: boolean = false,
): Array<{ comment: Comment; replies: CommentReply[] }> {
  const comments = getComments(prUuid, { unresolvedOnly });
  return comments.map((comment) => ({
    comment,
    replies: getReplies(comment.uuid),
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
  authorKind: AuthorKind = AuthorKind.Human,
  anchor?: {
    content: string;
    contextBefore: string;
    contextAfter: string;
    commit: string;
  },
): string {
  const conversationUuid = generateUuid();
  const messageUuid = generateUuid();
  // Resolved before getDatabase() below: getDefaultAgentAuthor/getDefaultHumanAuthor
  // call getDatabase() internally too, and if that triggers a reconnect (the
  // db file's mtime check in getDatabase() detects a change), a `db`
  // reference captured before this point would be left pointing at a
  // now-closed connection.
  const authorId = (
    authorKind === AuthorKind.Agent ? getDefaultAgentAuthor() : getDefaultHumanAuthor()
  ).id;
  const db = getDatabase();

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
      lineNumber,
    );

    // Get the conversation id
    const conv = db
      .prepare('SELECT id FROM repo_conversations WHERE uuid = ?')
      .get(conversationUuid) as { id: number };

    // Create first message
    db.prepare(`
      INSERT INTO repo_conversation_messages (uuid, conversation_id, author_id, content)
      VALUES (?, ?, ?, ?)
    `).run(messageUuid, conv.id, authorId, content);
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

export function listRepoConversations(
  options: {
    repoPath: string;
    filePath?: string;
    status?: ConversationStatus | 'all';
    limit?: number;
  } = { repoPath: '' },
): RepoConversationWithMessages[] {
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

  return conversations.map((conv) => {
    const messages = db
      .prepare(`
      SELECT rcm.id, rcm.uuid, rcm.conversation_id, rcm.author_id, a.name AS author, a.kind AS author_kind, rcm.content, rcm.created_at
      FROM repo_conversation_messages rcm
      JOIN authors a ON a.id = rcm.author_id
      WHERE rcm.conversation_id = ?
      ORDER BY rcm.created_at ASC
    `)
      .all(conv.id) as RepoConversationMessage[];

    return {
      conversation: conv,
      messages,
      message_count: messages.length,
    };
  });
}

export function getRepoConversationWithMessages(uuid: string): RepoConversationWithMessages | null {
  const db = getDatabase();
  const conv = db.prepare('SELECT * FROM repo_conversations WHERE uuid = ?').get(uuid) as
    | RepoConversation
    | undefined;
  if (!conv) return null;

  const messages = db
    .prepare(`
    SELECT rcm.id, rcm.uuid, rcm.conversation_id, rcm.author_id, a.name AS author, a.kind AS author_kind, rcm.content, rcm.created_at
    FROM repo_conversation_messages rcm
    JOIN authors a ON a.id = rcm.author_id
    WHERE rcm.conversation_id = ?
    ORDER BY rcm.created_at ASC
  `)
    .all(conv.id) as RepoConversationMessage[];

  return {
    conversation: conv,
    messages,
    message_count: messages.length,
  };
}

export function addRepoConversationMessage(
  conversationUuid: string,
  content: string,
  authorKind: AuthorKind = AuthorKind.Human,
): string {
  const messageUuid = generateUuid();
  // Resolved before getDatabase() below - see the matching comment in
  // createRepoConversation for why this ordering matters.
  const authorId = (
    authorKind === AuthorKind.Agent ? getDefaultAgentAuthor() : getDefaultHumanAuthor()
  ).id;
  const db = getDatabase();

  const conv = db
    .prepare('SELECT id FROM repo_conversations WHERE uuid = ?')
    .get(conversationUuid) as { id: number } | undefined;
  if (!conv) throw new Error(`Conversation ${conversationUuid} not found`);

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO repo_conversation_messages (uuid, conversation_id, author_id, content)
      VALUES (?, ?, ?, ?)
    `).run(messageUuid, conv.id, authorId, content);

    db.prepare(`
      UPDATE repo_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(conv.id);
  });

  transaction();
  checkpoint();
  return messageUuid;
}

export function updateRepoConversationStatus(uuid: string, status: ConversationStatus): boolean {
  const db = getDatabase();
  const result = db
    .prepare(`
    UPDATE repo_conversations
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE uuid = ?
  `)
    .run(status, uuid);
  checkpoint();
  return result.changes > 0;
}

export function updateRepoConversationAnchor(
  uuid: string,
  currentLineNumber: number | null,
  fileExists: boolean = true,
): boolean {
  const db = getDatabase();
  const result = db
    .prepare(`
    UPDATE repo_conversations
    SET current_line_number = ?, file_exists = ?, updated_at = CURRENT_TIMESTAMP
    WHERE uuid = ?
  `)
    .run(currentLineNumber, fileExists ? 1 : 0, uuid);
  checkpoint();
  return result.changes > 0;
}

export function getConversationCountsByFile(repoPath: string): Record<string, number> {
  const db = getDatabase();
  const rows = db
    .prepare(`
    SELECT file_path, COUNT(*) as count
    FROM repo_conversations
    WHERE repo_path = ? AND status != 'resolved'
    GROUP BY file_path
  `)
    .all(repoPath) as Array<{ file_path: string; count: number }>;

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
// Author Operations
// =============================================================================

export function getSetting(key: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
  checkpoint();
}

export function listAuthors(): Author[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM authors ORDER BY kind, name').all() as Author[];
}

export function getAuthorById(id: number): Author | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM authors WHERE id = ?').get(id);
  return row as Author | null;
}

export function getAuthorByName(name: string): Author | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM authors WHERE name = ? COLLATE NOCASE').get(name);
  return row as Author | null;
}

export function getDefaultHumanAuthor(): Author {
  const id = getSetting('default_human_author_id');
  const author = id ? getAuthorById(Number(id)) : null;
  if (!author) throw new Error('No default human author configured');
  return author;
}

export function getDefaultAgentAuthor(): Author {
  const id = getSetting('default_agent_author_id');
  const author = id ? getAuthorById(Number(id)) : null;
  if (!author) throw new Error('No default agent author configured');
  return author;
}

export function createAuthor(kind: AuthorKind, name: string, email: string | null = null): Author {
  const db = getDatabase();
  try {
    const result = db
      .prepare('INSERT INTO authors (kind, name, email) VALUES (?, ?, ?)')
      .run(kind, name, email);
    checkpoint();
    return getAuthorById(result.lastInsertRowid as number)!;
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw new Error(`An author named "${name}" already exists`);
    }
    throw e;
  }
}

export function updateAuthor(
  id: number,
  updates: { name?: string; email?: string | null },
): Author {
  const db = getDatabase();
  const existing = getAuthorById(id);
  if (!existing) throw new Error(`Author ${id} not found`);

  const name = updates.name ?? existing.name;
  const email = updates.email !== undefined ? updates.email : existing.email;

  try {
    db.prepare(
      'UPDATE authors SET name = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    ).run(name, email, id);
    checkpoint();
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw new Error(`An author named "${name}" already exists`);
    }
    throw e;
  }
  return getAuthorById(id)!;
}

export function deleteAuthor(id: number): void {
  const db = getDatabase();
  const author = getAuthorById(id);
  if (!author) throw new Error(`Author ${id} not found`);

  const replyCount = (
    db.prepare('SELECT COUNT(*) as count FROM comment_replies WHERE author_id = ?').get(id) as {
      count: number;
    }
  ).count;
  const messageCount = (
    db
      .prepare('SELECT COUNT(*) as count FROM repo_conversation_messages WHERE author_id = ?')
      .get(id) as { count: number }
  ).count;
  const totalReferences = replyCount + messageCount;
  if (totalReferences > 0) {
    throw new Error(
      `Cannot delete "${author.name}" - referenced by ${totalReferences} repl${totalReferences === 1 ? 'y' : 'ies'}`,
    );
  }

  const defaultKey =
    author.kind === AuthorKind.Human ? 'default_human_author_id' : 'default_agent_author_id';
  if (getSetting(defaultKey) === String(id)) {
    throw new Error(
      `Cannot delete "${author.name}" - it's the current default ${author.kind}. Set a different default first.`,
    );
  }

  db.prepare('DELETE FROM authors WHERE id = ?').run(id);
  checkpoint();
}

export function setDefaultAuthor(id: number): void {
  const author = getAuthorById(id);
  if (!author) throw new Error(`Author ${id} not found`);
  const key =
    author.kind === AuthorKind.Human ? 'default_human_author_id' : 'default_agent_author_id';
  setSetting(key, String(id));
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
