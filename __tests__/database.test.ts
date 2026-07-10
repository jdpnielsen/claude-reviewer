/**
 * Tests for the database module.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set up test database path before importing database module
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-test-'));
const testDbPath = path.join(testDbDir, 'test.db');
process.env.DATABASE_DIR = testDbDir;
process.env.DATABASE_PATH = testDbPath;

import {
  getDatabase,
  createPR,
  getPRByUuid,
  getPRById,
  listPRs,
  updatePRStatus,
  getLatestDiff,
  updatePRDiff,
  addComment,
  getComments,
  resolveComment,
  deleteComment,
  submitReview,
  getReviews,
  closeDatabase,
  listAuthors,
  getAuthorById,
  getAuthorByName,
  getDefaultHumanAuthor,
  getDefaultAgentAuthor,
  createAuthor,
  updateAuthor,
  deleteAuthor,
  setDefaultAuthor,
  addReply,
  getReplies,
  getCommentsWithReplies,
  createRepoConversation,
  addRepoConversationMessage,
  listRepoConversations,
  getRepoConversationWithMessages,
} from '../lib/database';

describe('Database Module', () => {
  afterAll(() => {
    closeDatabase();
    // Clean up test database
    try {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Pull Request Operations', () => {
    let testPRUuid: string;

    test('createPR creates a new PR and returns UUID', () => {
      testPRUuid = createPR(
        '/path/to/repo',
        'Test PR',
        'main',
        'feature',
        'abc123',
        'def456',
        'diff content',
        'Test description',
      );

      expect(testPRUuid).toBeDefined();
      expect(testPRUuid.length).toBe(8);
    });

    test('getPRByUuid retrieves PR by UUID', () => {
      const pr = getPRByUuid(testPRUuid);

      expect(pr).not.toBeNull();
      expect(pr?.title).toBe('Test PR');
      expect(pr?.base_ref).toBe('main');
      expect(pr?.head_ref).toBe('feature');
      expect(pr?.status).toBe('pending');
      expect(pr?.description).toBe('Test description');
    });

    test('getPRByUuid returns undefined for non-existent UUID', () => {
      const pr = getPRByUuid('nonexistent');
      expect(pr).toBeUndefined();
    });

    test('getPRById retrieves PR by ID', () => {
      const prByUuid = getPRByUuid(testPRUuid);
      expect(prByUuid).not.toBeNull();

      const pr = getPRById(prByUuid!.id);
      expect(pr).not.toBeNull();
      expect(pr?.uuid).toBe(testPRUuid);
    });

    test('listPRs returns all PRs', () => {
      // Create another PR
      createPR('/repo2', 'PR 2', 'main', 'f2', 'a', 'b', 'd2');

      const prs = listPRs();
      expect(prs.length).toBeGreaterThanOrEqual(2);
    });

    test('listPRs filters by repo path', () => {
      const prs = listPRs({ repoPath: '/path/to/repo' });
      expect(prs.length).toBeGreaterThanOrEqual(1);
      const foundPr = prs.find((pr) => pr.uuid === testPRUuid);
      expect(foundPr).toBeDefined();
    });

    test('listPRs filters by status', () => {
      const prs = listPRs({ status: 'pending' });
      expect(prs.length).toBeGreaterThanOrEqual(1);
      prs.forEach((pr) => expect(pr.status).toBe('pending'));
    });

    test('updatePRStatus updates PR status', () => {
      const result = updatePRStatus(testPRUuid, 'approved');
      expect(result).toBe(true);

      const pr = getPRByUuid(testPRUuid);
      expect(pr?.status).toBe('approved');
    });

    test('getLatestDiff returns diff content', () => {
      const diff = getLatestDiff(testPRUuid);
      expect(diff).toBe('diff content');
    });

    test('getLatestDiff returns null for non-existent PR', () => {
      const diff = getLatestDiff('nonexistent');
      expect(diff).toBeNull();
    });

    test('updatePRDiff adds new revision', () => {
      const newRevision = updatePRDiff(testPRUuid, 'new diff content', 'newcommit');
      expect(newRevision).toBe(2);

      const diff = getLatestDiff(testPRUuid);
      expect(diff).toBe('new diff content');
    });

    test('updatePRDiff throws for non-existent PR', () => {
      expect(() => {
        updatePRDiff('nonexistent', 'diff', 'commit');
      }).toThrow('PR nonexistent not found');
    });
  });

  describe('Comment Operations', () => {
    let prUuid: string;
    let commentUuid: string;

    beforeAll(() => {
      prUuid = createPR('/repo/comments', 'Comment Test PR', 'main', 'feature', 'a', 'b', 'diff');
    });

    test('addComment creates a comment and returns UUID', () => {
      commentUuid = addComment(prUuid, 'src/app.py', 42, 'Fix this issue');

      expect(commentUuid).toBeDefined();
      expect(commentUuid.length).toBe(8);
    });

    test('addComment throws for non-existent PR', () => {
      expect(() => {
        addComment('nonexistent', 'file.py', 1, 'comment');
      }).toThrow('PR nonexistent not found');
    });

    test('getComments retrieves comments for PR', () => {
      addComment(prUuid, 'file2.py', 20, 'Comment 2');

      const comments = getComments(prUuid);
      expect(comments.length).toBe(2);
    });

    test('getComments filters by file path', () => {
      const comments = getComments(prUuid, { filePath: 'src/app.py' });
      expect(comments.length).toBe(1);
      expect(comments[0].content).toBe('Fix this issue');
    });

    test('getComments returns empty for non-existent PR', () => {
      const comments = getComments('nonexistent');
      expect(comments).toEqual([]);
    });

    test('resolveComment marks comment as resolved', () => {
      const result = resolveComment(commentUuid, true);
      expect(result).toBe(true);

      const comments = getComments(prUuid);
      const resolved = comments.find((c) => c.uuid === commentUuid);
      expect(resolved?.resolved).toBe(1); // SQLite stores booleans as integers
    });

    test('getComments filters unresolved only', () => {
      const unresolved = getComments(prUuid, { unresolvedOnly: true });
      expect(unresolved.length).toBe(1);
      expect(unresolved[0].content).toBe('Comment 2');
    });

    test('deleteComment removes comment', () => {
      const newComment = addComment(prUuid, 'temp.py', 1, 'To delete');
      const result = deleteComment(newComment);
      expect(result).toBe(true);

      const comments = getComments(prUuid, { filePath: 'temp.py' });
      expect(comments.length).toBe(0);
    });

    test('addComment defaults commit_sha to null and stores it when provided', () => {
      const cumulativeUuid = addComment(prUuid, 'scoped.py', 1, 'cumulative comment');
      const scopedUuid = addComment(prUuid, 'scoped.py', 2, 'commit comment', 'new', 2, 'abc1234');

      const fileComments = getComments(prUuid, { filePath: 'scoped.py' });
      const cumulative = fileComments.find((c) => c.uuid === cumulativeUuid);
      const scoped = fileComments.find((c) => c.uuid === scopedUuid);

      expect(cumulative?.commit_sha).toBeNull();
      expect(scoped?.commit_sha).toBe('abc1234');
    });
  });

  describe('Review Operations', () => {
    let prUuid: string;

    beforeAll(() => {
      prUuid = createPR('/repo/reviews', 'Review Test PR', 'main', 'feature', 'a', 'b', 'diff');
    });

    test('submitReview approves PR', () => {
      const result = submitReview(prUuid, 'approve', 'LGTM!');
      expect(result).toBe(true);

      const pr = getPRByUuid(prUuid);
      expect(pr?.status).toBe('approved');
    });

    test('submitReview requests changes', () => {
      const result = submitReview(prUuid, 'request_changes', 'Needs work');
      expect(result).toBe(true);

      const pr = getPRByUuid(prUuid);
      expect(pr?.status).toBe('changes_requested');
    });

    test('submitReview throws for non-existent PR', () => {
      expect(() => {
        submitReview('nonexistent', 'approve');
      }).toThrow('PR nonexistent not found');
    });

    test('getReviews retrieves all reviews', () => {
      const reviews = getReviews(prUuid);
      expect(reviews.length).toBe(2);

      // Check both actions are present (order may vary due to fast insertion)
      const actions = reviews.map((r) => r.action);
      expect(actions).toContain('approve');
      expect(actions).toContain('request_changes');
    });

    test('getReviews returns empty for non-existent PR', () => {
      const reviews = getReviews('nonexistent');
      expect(reviews).toEqual([]);
    });
  });

  describe('Author Operations', () => {
    test('seeding creates exactly one agent row named claude', () => {
      const authors = listAuthors();
      const agents = authors.filter((a) => a.kind === 'agent');
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('claude');
    });

    test('seeding creates exactly one human row', () => {
      const authors = listAuthors();
      const humans = authors.filter((a) => a.kind === 'human');
      expect(humans.length).toBe(1);
    });

    test('getDefaultHumanAuthor and getDefaultAgentAuthor resolve the seeded rows', () => {
      const human = getDefaultHumanAuthor();
      const agent = getDefaultAgentAuthor();
      expect(human.kind).toBe('human');
      expect(agent.kind).toBe('agent');
      expect(agent.name).toBe('claude');
    });

    test('createAuthor adds a new row and getAuthorByName finds it case-insensitively', () => {
      const created = createAuthor('human', 'Alice', 'alice@example.com');
      expect(created.id).toBeDefined();
      expect(created.email).toBe('alice@example.com');

      const found = getAuthorByName('ALICE');
      expect(found?.id).toBe(created.id);
    });

    test('createAuthor rejects a duplicate name case-insensitively', () => {
      createAuthor('human', 'Bob');
      expect(() => createAuthor('human', 'bob')).toThrow(/already exists/i);
    });

    test('updateAuthor changes name and email without touching kind', () => {
      const created = createAuthor('human', 'Carol');
      const updated = updateAuthor(created.id, { name: 'Caroline', email: 'c@example.com' });
      expect(updated.name).toBe('Caroline');
      expect(updated.email).toBe('c@example.com');
      expect(updated.kind).toBe('human');
    });

    test('deleteAuthor refuses to delete an author referenced by a reply', () => {
      const author = createAuthor('human', 'Dave');
      const prUuid = createPR(
        '/repo/authors',
        'Author Test PR',
        'main',
        'feature',
        'a',
        'b',
        'diff',
      );
      const commentUuid = addComment(prUuid, 'file.py', 1, 'a comment');
      // addReply isn't rewired onto author_id until Task 5, so for this task
      // insert directly against the schema to set up a referencing row.
      const rawDb = getDatabase();
      const comment = rawDb.prepare('SELECT id FROM comments WHERE uuid = ?').get(commentUuid) as {
        id: number;
      };
      rawDb
        .prepare(
          'INSERT INTO comment_replies (uuid, comment_id, author_id, content) VALUES (?, ?, ?, ?)',
        )
        .run('replyuuid1', comment.id, author.id, 'a reply');

      expect(() => deleteAuthor(author.id)).toThrow(/referenced by 1 reply/i);
    });

    test('deleteAuthor refuses to delete the current default', () => {
      const human = getDefaultHumanAuthor();
      expect(() => deleteAuthor(human.id)).toThrow(/current default/i);
    });

    test('deleteAuthor succeeds for an unreferenced, non-default author', () => {
      const author = createAuthor('human', 'Eve');
      deleteAuthor(author.id);
      expect(getAuthorById(author.id)).toBeUndefined();
    });

    test("setDefaultAuthor repoints the default for that author's kind", () => {
      const newHuman = createAuthor('human', 'Frank');
      setDefaultAuthor(newHuman.id);
      expect(getDefaultHumanAuthor().id).toBe(newHuman.id);
    });
  });

  describe('Comment Reply Operations', () => {
    let prUuid: string;
    let commentUuid: string;

    beforeAll(() => {
      prUuid = createPR('/repo/replies', 'Reply Test PR', 'main', 'feature', 'a', 'b', 'diff');
      commentUuid = addComment(prUuid, 'file.py', 1, 'a comment');
    });

    test('addReply always attributes to the default human author', () => {
      const replyUuid = addReply(commentUuid, 'a reply');
      expect(replyUuid).toBeDefined();

      const replies = getReplies(commentUuid);
      const reply = replies.find((r) => r.uuid === replyUuid);
      expect(reply?.author).toBe(getDefaultHumanAuthor().name);
      expect(reply?.author_kind).toBe('human');
    });

    test('renaming the default human author retroactively updates past replies', () => {
      const replyUuid = addReply(commentUuid, 'another reply');
      const human = getDefaultHumanAuthor();
      updateAuthor(human.id, { name: 'Renamed Human' });

      const replies = getReplies(commentUuid);
      const reply = replies.find((r) => r.uuid === replyUuid);
      expect(reply?.author).toBe('Renamed Human');
    });

    test('getCommentsWithReplies includes author_kind on each reply', () => {
      const withReplies = getCommentsWithReplies(prUuid);
      const target = withReplies.find((c) => c.comment.uuid === commentUuid);
      expect(target?.replies.every((r) => r.author_kind === 'human')).toBe(true);
    });
  });

  describe('Repo Conversation Operations', () => {
    test('createRepoConversation defaults to the default human author', () => {
      const convUuid = createRepoConversation('/repo/conv', 'file.py', 10, 'first message');
      const withMessages = getRepoConversationWithMessages(convUuid);
      expect(withMessages?.messages[0].author).toBe(getDefaultHumanAuthor().name);
      expect(withMessages?.messages[0].author_kind).toBe('human');
    });

    test("createRepoConversation with 'claude' hint attributes to the default agent", () => {
      const convUuid = createRepoConversation(
        '/repo/conv',
        'file2.py',
        5,
        "claude's opening",
        'claude',
      );
      const withMessages = getRepoConversationWithMessages(convUuid);
      expect(withMessages?.messages[0].author).toBe('claude');
      expect(withMessages?.messages[0].author_kind).toBe('agent');
    });

    test("addRepoConversationMessage with 'claude' hint attributes to the default agent", () => {
      const convUuid = createRepoConversation('/repo/conv', 'file3.py', 1, 'human message');
      addRepoConversationMessage(convUuid, "claude's reply", 'claude');

      const withMessages = getRepoConversationWithMessages(convUuid);
      expect(withMessages?.messages[1].author).toBe('claude');
      expect(withMessages?.messages[1].author_kind).toBe('agent');
    });

    test('listRepoConversations includes author_kind on each message', () => {
      createRepoConversation('/repo/conv-list', 'file.py', 1, 'a message');
      const list = listRepoConversations({ repoPath: '/repo/conv-list' });
      expect(list[0].messages[0].author_kind).toBe('human');
    });
  });
});
