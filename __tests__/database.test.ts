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
  applyCommentRelocations,
  upsertCommitRelocation,
  lookupCommitRelocation,
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
import {
  AuthorKind,
  CommentRelocationStatus,
  CommentTargetType,
  LineType,
  PullRequestStatus,
  ReviewAction,
} from '../lib/enum';

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
      expect(pr?.status).toBe(PullRequestStatus.Pending);
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
      const prs = listPRs({ status: PullRequestStatus.Pending });
      expect(prs.length).toBeGreaterThanOrEqual(1);
      prs.forEach((pr) => expect(pr.status).toBe(PullRequestStatus.Pending));
    });

    test('listPRs excludeClosed hides closed PRs from the unfiltered listing', () => {
      const openUuid = createPR('/repo/exclude', 'Open PR', 'main', 'f', 'a', 'b', 'd');
      const closedUuid = createPR('/repo/exclude', 'Closed PR', 'main', 'f', 'a', 'b', 'd');
      updatePRStatus(closedUuid, PullRequestStatus.Closed);

      const withClosed = listPRs({ repoPath: '/repo/exclude' });
      expect(withClosed.map((pr) => pr.uuid)).toEqual(
        expect.arrayContaining([openUuid, closedUuid]),
      );

      const withoutClosed = listPRs({ repoPath: '/repo/exclude', excludeClosed: true });
      const uuids = withoutClosed.map((pr) => pr.uuid);
      expect(uuids).toContain(openUuid);
      expect(uuids).not.toContain(closedUuid);
    });

    test('listPRs excludeClosed only hides "closed" status, not other terminal states', () => {
      const mergedUuid = createPR('/repo/exclude2', 'Merged PR', 'main', 'f', 'a', 'b', 'd');
      updatePRStatus(mergedUuid, PullRequestStatus.Merged);

      const prs = listPRs({ repoPath: '/repo/exclude2', excludeClosed: true });
      expect(prs.map((pr) => pr.uuid)).toContain(mergedUuid);
    });

    test('listPRs excludeClosed is ignored when an explicit status is given', () => {
      const closedUuid = createPR('/repo/exclude3', 'Closed PR', 'main', 'f', 'a', 'b', 'd');
      updatePRStatus(closedUuid, PullRequestStatus.Closed);

      // An explicit `status` always wins - excludeClosed must not suppress a
      // deliberate request for closed PRs.
      const prs = listPRs({
        repoPath: '/repo/exclude3',
        status: PullRequestStatus.Closed,
        excludeClosed: true,
      });
      expect(prs.map((pr) => pr.uuid)).toContain(closedUuid);
    });

    test('updatePRStatus updates PR status', () => {
      const result = updatePRStatus(testPRUuid, PullRequestStatus.Approved);
      expect(result).toBe(true);

      const pr = getPRByUuid(testPRUuid);
      expect(pr?.status).toBe(PullRequestStatus.Approved);
    });

    test('getLatestDiff returns diff content', () => {
      const diff = getLatestDiff(testPRUuid);
      expect(diff).toBe('diff content');
    });

    test('getLatestDiff returns null for non-existent PR', () => {
      const diff = getLatestDiff('nonexistent');
      expect(diff).toBeNull();
    });

    test('updatePRDiff adds new revision and returns the pre-update commits', () => {
      const result = updatePRDiff(testPRUuid, 'new diff content', 'newcommit', 'newbase');
      expect(result.revision).toBe(2);
      expect(result.oldHeadCommit).toBe('def456');
      expect(result.oldBaseCommit).toBe('abc123');

      const diff = getLatestDiff(testPRUuid);
      expect(diff).toBe('new diff content');

      const pr = getPRByUuid(testPRUuid);
      expect(pr?.head_commit).toBe('newcommit');
      expect(pr?.base_commit).toBe('newbase');
    });

    test('updatePRDiff throws for non-existent PR', () => {
      expect(() => {
        updatePRDiff('nonexistent', 'diff', 'commit', 'base');
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
      const scopedUuid = addComment(
        prUuid,
        'scoped.py',
        2,
        'commit comment',
        LineType.New,
        2,
        'abc1234',
      );

      const fileComments = getComments(prUuid, { filePath: 'scoped.py' });
      const cumulative = fileComments.find((c) => c.uuid === cumulativeUuid);
      const scoped = fileComments.find((c) => c.uuid === scopedUuid);

      expect(cumulative?.commit_sha).toBeNull();
      expect(scoped?.commit_sha).toBe('abc1234');
    });

    test('addComment defaults target_type to line and stores commit_message when provided', () => {
      const lineUuid = addComment(prUuid, 'targeted.py', 1, 'line comment');
      const commitMessageUuid = addComment(
        prUuid,
        '',
        0,
        'commit message comment',
        LineType.New,
        0,
        'def5678',
        CommentTargetType.CommitMessage,
      );

      const line = getComments(prUuid, { filePath: 'targeted.py' }).find(
        (c) => c.uuid === lineUuid,
      );
      const commitMessage = getComments(prUuid).find((c) => c.uuid === commitMessageUuid);

      expect(line?.target_type).toBe(CommentTargetType.Line);
      expect(commitMessage?.target_type).toBe(CommentTargetType.CommitMessage);
      expect(commitMessage?.commit_sha).toBe('def5678');
    });

    test('addComment stores an anchor when provided, and defaults status to active', () => {
      const anchoredUuid = addComment(
        prUuid,
        'anchored.py',
        5,
        'anchored comment',
        LineType.New,
        5,
        null,
        CommentTargetType.Line,
        { content: 'the line', contextBefore: 'before1\nbefore2', contextAfter: 'after1\nafter2' },
      );
      const unanchoredUuid = addComment(prUuid, 'anchored.py', 6, 'no anchor');

      const comments = getComments(prUuid, { filePath: 'anchored.py' });
      const anchored = comments.find((c) => c.uuid === anchoredUuid);
      const unanchored = comments.find((c) => c.uuid === unanchoredUuid);

      expect(anchored?.anchor_content).toBe('the line');
      expect(anchored?.anchor_context_before).toBe('before1\nbefore2');
      expect(anchored?.anchor_context_after).toBe('after1\nafter2');
      expect(anchored?.status).toBe(CommentRelocationStatus.Active);
      expect(unanchored?.anchor_content).toBeNull();
      expect(unanchored?.status).toBe(CommentRelocationStatus.Active);
    });
  });

  describe('Comment Relocation Operations', () => {
    let prUuid: string;

    beforeAll(() => {
      prUuid = createPR('/repo/relocation', 'Relocation Test PR', 'main', 'feature', 'a', 'b', 'diff');
    });

    test('applyCommentRelocations mutates coordinates and status in one shot', () => {
      const commentUuid = addComment(prUuid, 'moved.py', 10, 'a comment', LineType.New, 10, 'oldsha');
      const comment = getComments(prUuid, { filePath: 'moved.py' }).find(
        (c) => c.uuid === commentUuid,
      )!;

      applyCommentRelocations([
        {
          commentId: comment.id,
          commitSha: 'newsha',
          filePath: 'renamed.py',
          lineNumber: 20,
          endLineNumber: 21,
          status: CommentRelocationStatus.Active,
        },
      ]);

      const relocated = getComments(prUuid, { filePath: 'renamed.py' }).find(
        (c) => c.uuid === commentUuid,
      );
      expect(relocated?.commit_sha).toBe('newsha');
      expect(relocated?.line_number).toBe(20);
      expect(relocated?.end_line_number).toBe(21);
      expect(relocated?.status).toBe(CommentRelocationStatus.Active);
    });

    test('applyCommentRelocations can mark a comment orphaned', () => {
      const commentUuid = addComment(prUuid, 'dropped.py', 1, 'a comment', LineType.New, 1, 'oldsha2');
      const comment = getComments(prUuid, { filePath: 'dropped.py' }).find(
        (c) => c.uuid === commentUuid,
      )!;

      applyCommentRelocations([
        {
          commentId: comment.id,
          commitSha: comment.commit_sha,
          filePath: comment.file_path,
          lineNumber: comment.line_number,
          endLineNumber: comment.end_line_number,
          status: CommentRelocationStatus.Orphaned,
        },
      ]);

      const orphaned = getComments(prUuid, { filePath: 'dropped.py' }).find(
        (c) => c.uuid === commentUuid,
      );
      expect(orphaned?.status).toBe(CommentRelocationStatus.Orphaned);
    });

    test('applyCommentRelocations is a no-op for an empty list', () => {
      expect(() => applyCommentRelocations([])).not.toThrow();
    });

    test('upsertCommitRelocation + lookupCommitRelocation round-trip', () => {
      expect(lookupCommitRelocation(prUuid, 'sha-a')).toBeNull();

      upsertCommitRelocation(prUuid, 'sha-a', 'sha-b');
      expect(lookupCommitRelocation(prUuid, 'sha-a')).toBe('sha-b');
    });

    test('upsertCommitRelocation collapses chains so old links resolve in one lookup', () => {
      upsertCommitRelocation(prUuid, 'chain-a', 'chain-b');
      expect(lookupCommitRelocation(prUuid, 'chain-a')).toBe('chain-b');

      // A second sync relocates chain-b -> chain-c. The first sync's mapping
      // should now point straight at chain-c, not still at chain-b.
      upsertCommitRelocation(prUuid, 'chain-b', 'chain-c');
      expect(lookupCommitRelocation(prUuid, 'chain-a')).toBe('chain-c');
      expect(lookupCommitRelocation(prUuid, 'chain-b')).toBe('chain-c');
    });

    test('upsertCommitRelocation throws for a non-existent PR', () => {
      expect(() => upsertCommitRelocation('nonexistent', 'a', 'b')).toThrow('PR nonexistent not found');
    });
  });

  describe('Review Operations', () => {
    let prUuid: string;

    beforeAll(() => {
      prUuid = createPR('/repo/reviews', 'Review Test PR', 'main', 'feature', 'a', 'b', 'diff');
    });

    test('submitReview approves PR', () => {
      const result = submitReview(prUuid, ReviewAction.Approve, 'LGTM!');
      expect(result).toBe(true);

      const pr = getPRByUuid(prUuid);
      expect(pr?.status).toBe(PullRequestStatus.Approved);
    });

    test('submitReview requests changes', () => {
      const result = submitReview(prUuid, ReviewAction.RequestChanges, 'Needs work');
      expect(result).toBe(true);

      const pr = getPRByUuid(prUuid);
      expect(pr?.status).toBe(PullRequestStatus.ChangesRequested);
    });

    test('submitReview throws for non-existent PR', () => {
      expect(() => {
        submitReview('nonexistent', ReviewAction.Approve);
      }).toThrow('PR nonexistent not found');
    });

    test('getReviews retrieves all reviews', () => {
      const reviews = getReviews(prUuid);
      expect(reviews.length).toBe(2);

      // Check both actions are present (order may vary due to fast insertion)
      const actions = reviews.map((r) => r.action);
      expect(actions).toContain(ReviewAction.Approve);
      expect(actions).toContain(ReviewAction.RequestChanges);
    });

    test('getReviews returns empty for non-existent PR', () => {
      const reviews = getReviews('nonexistent');
      expect(reviews).toEqual([]);
    });
  });

  describe('Author Operations', () => {
    test('seeding creates exactly one agent row named claude', () => {
      const authors = listAuthors();
      const agents = authors.filter((a) => a.kind === AuthorKind.Agent);
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('claude');
    });

    test('seeding creates exactly one human row', () => {
      const authors = listAuthors();
      const humans = authors.filter((a) => a.kind === AuthorKind.Human);
      expect(humans.length).toBe(1);
    });

    test('getDefaultHumanAuthor and getDefaultAgentAuthor resolve the seeded rows', () => {
      const human = getDefaultHumanAuthor();
      const agent = getDefaultAgentAuthor();
      expect(human.kind).toBe(AuthorKind.Human);
      expect(agent.kind).toBe(AuthorKind.Agent);
      expect(agent.name).toBe('claude');
    });

    test('createAuthor adds a new row and getAuthorByName finds it case-insensitively', () => {
      const created = createAuthor(AuthorKind.Human, 'Alice', 'alice@example.com');
      expect(created.id).toBeDefined();
      expect(created.email).toBe('alice@example.com');

      const found = getAuthorByName('ALICE');
      expect(found?.id).toBe(created.id);
    });

    test('createAuthor rejects a duplicate name case-insensitively', () => {
      createAuthor(AuthorKind.Human, 'Bob');
      expect(() => createAuthor(AuthorKind.Human, 'bob')).toThrow(/already exists/i);
    });

    test('updateAuthor changes name and email without touching kind', () => {
      const created = createAuthor(AuthorKind.Human, 'Carol');
      const updated = updateAuthor(created.id, { name: 'Caroline', email: 'c@example.com' });
      expect(updated.name).toBe('Caroline');
      expect(updated.email).toBe('c@example.com');
      expect(updated.kind).toBe(AuthorKind.Human);
    });

    test('deleteAuthor refuses to delete an author referenced by a reply', () => {
      const author = createAuthor(AuthorKind.Human, 'Dave');
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
      const author = createAuthor(AuthorKind.Human, 'Eve');
      deleteAuthor(author.id);
      expect(getAuthorById(author.id)).toBeUndefined();
    });

    test("setDefaultAuthor repoints the default for that author's kind", () => {
      const newHuman = createAuthor(AuthorKind.Human, 'Frank');
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
      expect(reply?.author_kind).toBe(AuthorKind.Human);
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
      expect(target?.replies.every((r) => r.author_kind === AuthorKind.Human)).toBe(true);
    });
  });

  describe('Repo Conversation Operations', () => {
    test('createRepoConversation defaults to the default human author', () => {
      const convUuid = createRepoConversation('/repo/conv', 'file.py', 10, 'first message');
      const withMessages = getRepoConversationWithMessages(convUuid);
      expect(withMessages?.messages[0].author).toBe(getDefaultHumanAuthor().name);
      expect(withMessages?.messages[0].author_kind).toBe(AuthorKind.Human);
    });

    test("createRepoConversation with 'claude' hint attributes to the default agent", () => {
      const convUuid = createRepoConversation(
        '/repo/conv',
        'file2.py',
        5,
        "claude's opening",
        AuthorKind.Agent,
      );
      const withMessages = getRepoConversationWithMessages(convUuid);
      expect(withMessages?.messages[0].author).toBe('claude');
      expect(withMessages?.messages[0].author_kind).toBe(AuthorKind.Agent);
    });

    test("addRepoConversationMessage with 'claude' hint attributes to the default agent", () => {
      const convUuid = createRepoConversation('/repo/conv', 'file3.py', 1, 'human message');
      addRepoConversationMessage(convUuid, "claude's reply", AuthorKind.Agent);

      const withMessages = getRepoConversationWithMessages(convUuid);
      expect(withMessages?.messages[1].author).toBe('claude');
      expect(withMessages?.messages[1].author_kind).toBe(AuthorKind.Agent);
    });

    test('listRepoConversations includes author_kind on each message', () => {
      createRepoConversation('/repo/conv-list', 'file.py', 1, 'a message');
      const list = listRepoConversations({ repoPath: '/repo/conv-list' });
      expect(list[0].messages[0].author_kind).toBe(AuthorKind.Human);
    });
  });
});
