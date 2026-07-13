"""Tests for the database module."""

from __future__ import annotations

from pathlib import Path

import pytest

from claude_reviewer import database as db
from claude_reviewer.models import PRStatus, ReviewAction


class TestPullRequests:
    """Tests for PR operations."""

    def test_create_pr(self, temp_db: Path) -> None:
        """Test creating a PR."""
        uuid = db.create_pr(
            repo_path="/path/to/repo",
            title="Test PR",
            base_ref="main",
            head_ref="feature",
            base_commit="abc123",
            head_commit="def456",
            diff="diff content",
            description="Test description",
        )

        assert uuid is not None
        assert len(uuid) == 8

    def test_get_pr_by_uuid(self, temp_db: Path) -> None:
        """Test retrieving a PR by UUID."""
        uuid = db.create_pr(
            repo_path="/path/to/repo",
            title="Test PR",
            base_ref="main",
            head_ref="feature",
            base_commit="abc123",
            head_commit="def456",
            diff="diff content",
        )

        pr = db.get_pr_by_uuid(uuid)
        assert pr is not None
        assert pr.title == "Test PR"
        assert pr.base_ref == "main"
        assert pr.head_ref == "feature"
        assert pr.status == PRStatus.PENDING

    def test_get_pr_by_uuid_not_found(self, temp_db: Path) -> None:
        """Test retrieving a non-existent PR."""
        pr = db.get_pr_by_uuid("nonexistent")
        assert pr is None

    def test_delete_pr(self, temp_db: Path) -> None:
        """Test deleting a PR."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        # Add a comment to verify cascade delete
        db.add_comment(uuid, "file.py", 1, "comment")

        result = db.delete_pr(uuid)
        assert result is True

        pr = db.get_pr_by_uuid(uuid)
        assert pr is None

        comments = db.get_comments(uuid)
        assert len(comments) == 0

    def test_list_prs(self, temp_db: Path) -> None:
        """Test listing PRs."""
        # Create multiple PRs
        db.create_pr(
            repo_path="/repo1",
            title="PR 1",
            base_ref="main",
            head_ref="f1",
            base_commit="a",
            head_commit="b",
            diff="d1",
        )
        db.create_pr(
            repo_path="/repo2",
            title="PR 2",
            base_ref="main",
            head_ref="f2",
            base_commit="c",
            head_commit="d",
            diff="d2",
        )

        prs = db.list_prs()
        assert len(prs) == 2

    def test_list_prs_with_filter(self, temp_db: Path) -> None:
        """Test listing PRs with filters."""
        uuid1 = db.create_pr(
            repo_path="/repo1",
            title="PR 1",
            base_ref="main",
            head_ref="f1",
            base_commit="a",
            head_commit="b",
            diff="d1",
        )
        db.create_pr(
            repo_path="/repo2",
            title="PR 2",
            base_ref="main",
            head_ref="f2",
            base_commit="c",
            head_commit="d",
            diff="d2",
        )

        # Filter by repo
        prs = db.list_prs(repo_path="/repo1")
        assert len(prs) == 1
        assert prs[0].uuid == uuid1

        # Update status and filter
        db.update_pr_status(uuid1, PRStatus.APPROVED)
        prs = db.list_prs(status=PRStatus.APPROVED)
        assert len(prs) == 1

    def test_update_pr_status(self, temp_db: Path) -> None:
        """Test updating PR status."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        result = db.update_pr_status(uuid, PRStatus.APPROVED)
        assert result is True

        pr = db.get_pr_by_uuid(uuid)
        assert pr is not None
        assert pr.status == PRStatus.APPROVED

    def test_update_pr_diff(self, temp_db: Path) -> None:
        """Test updating PR diff."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="original diff",
        )

        new_revision = db.update_pr_diff(uuid, "new diff content", "newcommit")
        assert new_revision == 2

        diff = db.get_latest_diff(uuid)
        assert diff == "new diff content"

    def test_get_latest_diff(self, temp_db: Path) -> None:
        """Test getting latest diff."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="diff content",
        )

        diff = db.get_latest_diff(uuid)
        assert diff == "diff content"


class TestComments:
    """Tests for comment operations."""

    def test_add_comment(self, temp_db: Path) -> None:
        """Test adding a comment."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        comment_uuid = db.add_comment(
            pr_uuid=uuid,
            file_path="src/app.py",
            line_number=42,
            content="Fix this issue",
        )

        assert comment_uuid is not None
        assert len(comment_uuid) == 8

    def test_add_comment_stores_commit_sha(self, temp_db: Path) -> None:
        """Test that commit_sha defaults to None and can be set."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        db.add_comment(pr_uuid=uuid, file_path="scoped.py", line_number=1, content="cumulative")
        db.add_comment(
            pr_uuid=uuid,
            file_path="scoped.py",
            line_number=2,
            content="scoped",
            commit_sha="abc1234",
        )

        comments = db.get_comments(uuid, file_path="scoped.py")
        cumulative = next(c for c in comments if c.content == "cumulative")
        scoped = next(c for c in comments if c.content == "scoped")
        assert cumulative.commit_sha is None
        assert scoped.commit_sha == "abc1234"

    def test_add_comment_defaults_target_type_to_line(self, temp_db: Path) -> None:
        """Test that target_type defaults to 'line' and can be set to 'commit_message'."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        db.add_comment(pr_uuid=uuid, file_path="targeted.py", line_number=1, content="line")
        db.add_comment(
            pr_uuid=uuid,
            file_path="",
            line_number=0,
            content="commit message comment",
            commit_sha="def5678",
            target_type="commit_message",
        )

        comments = db.get_comments(uuid)
        line = next(c for c in comments if c.content == "line")
        commit_message = next(c for c in comments if c.content == "commit message comment")
        assert line.target_type == "line"
        assert commit_message.target_type == "commit_message"
        assert commit_message.commit_sha == "def5678"

    def test_get_comments(self, temp_db: Path) -> None:
        """Test retrieving comments."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        db.add_comment(uuid, "file1.py", 10, "Comment 1")
        db.add_comment(uuid, "file2.py", 20, "Comment 2")

        comments = db.get_comments(uuid)
        assert len(comments) == 2

    def test_get_comments_unresolved_only(self, temp_db: Path) -> None:
        """Test filtering unresolved comments."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        c1 = db.add_comment(uuid, "file1.py", 10, "Comment 1")
        db.add_comment(uuid, "file2.py", 20, "Comment 2")

        # Resolve first comment
        db.resolve_comment(c1, resolved=True)

        unresolved = db.get_comments(uuid, unresolved_only=True)
        assert len(unresolved) == 1
        assert unresolved[0].content == "Comment 2"

    def test_resolve_comment(self, temp_db: Path) -> None:
        """Test resolving a comment."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        comment_uuid = db.add_comment(uuid, "file.py", 10, "Fix this")

        result = db.resolve_comment(comment_uuid, resolved=True)
        assert result is True

        comments = db.get_comments(uuid)
        assert len(comments) == 1
        assert comments[0].resolved is True


class TestReviews:
    """Tests for review operations."""

    def test_submit_review_approve(self, temp_db: Path) -> None:
        """Test submitting an approval review."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        result = db.submit_review(uuid, ReviewAction.APPROVE, summary="LGTM!")
        assert result is True

        pr = db.get_pr_by_uuid(uuid)
        assert pr is not None
        assert pr.status == PRStatus.APPROVED

    def test_submit_review_request_changes(self, temp_db: Path) -> None:
        """Test submitting a request changes review."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        result = db.submit_review(uuid, ReviewAction.REQUEST_CHANGES, summary="Needs work")
        assert result is True

        pr = db.get_pr_by_uuid(uuid)
        assert pr is not None
        assert pr.status == PRStatus.CHANGES_REQUESTED

    def test_get_reviews(self, temp_db: Path) -> None:
        """Test retrieving reviews."""
        uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )

        db.submit_review(uuid, ReviewAction.REQUEST_CHANGES, "Fix issues")
        db.submit_review(uuid, ReviewAction.APPROVE, "All good now")

        reviews = db.get_reviews(uuid)
        assert len(reviews) == 2


class TestAuthors:
    """Tests for author operations."""

    def test_seeding_creates_one_agent_row_named_claude(self, temp_db: Path) -> None:
        authors = db.list_authors()
        agents = [a for a in authors if a.kind == "agent"]
        assert len(agents) == 1
        assert agents[0].name == "claude"

    def test_seeding_creates_one_human_row(self, temp_db: Path) -> None:
        authors = db.list_authors()
        humans = [a for a in authors if a.kind == "human"]
        assert len(humans) == 1

    def test_get_default_human_and_agent_authors(self, temp_db: Path) -> None:
        human = db.get_default_human_author()
        agent = db.get_default_agent_author()
        assert human.kind == "human"
        assert agent.kind == "agent"
        assert agent.name == "claude"

    def test_create_author_and_get_by_name_case_insensitive(self, temp_db: Path) -> None:
        created = db.create_author("human", "Alice", "alice@example.com")
        assert created.id is not None
        assert created.email == "alice@example.com"

        found = db.get_author_by_name("ALICE")
        assert found is not None
        assert found.id == created.id

    def test_create_author_rejects_duplicate_name_case_insensitive(self, temp_db: Path) -> None:
        db.create_author("human", "Bob")
        with pytest.raises(ValueError, match="already exists"):
            db.create_author("human", "bob")

    def test_update_author_changes_name_and_email(self, temp_db: Path) -> None:
        created = db.create_author("human", "Carol")
        updated = db.update_author(created.id, name="Caroline", email="c@example.com")
        assert updated.name == "Caroline"
        assert updated.email == "c@example.com"
        assert updated.kind == "human"

    def test_delete_author_refuses_referenced_author(self, temp_db: Path) -> None:
        author = db.create_author("human", "Dave")
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")
        db.add_reply(comment_uuid, "a reply", author=author.name)

        with pytest.raises(ValueError, match="referenced by 1 reply"):
            db.delete_author(author.id)

    def test_delete_author_refuses_current_default(self, temp_db: Path) -> None:
        human = db.get_default_human_author()
        with pytest.raises(ValueError, match="current default"):
            db.delete_author(human.id)

    def test_delete_author_succeeds_for_unreferenced_non_default(self, temp_db: Path) -> None:
        author = db.create_author("human", "Eve")
        db.delete_author(author.id)
        assert db.get_author_by_id(author.id) is None

    def test_set_default_author_repoints_default(self, temp_db: Path) -> None:
        new_human = db.create_author("human", "Frank")
        db.set_default_author(new_human.id)
        assert db.get_default_human_author().id == new_human.id


class TestCommentReplies:
    """Tests for comment reply operations."""

    def test_add_reply_me_sentinel_resolves_to_default_human(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")

        db.add_reply(comment_uuid, "a reply", author="me")
        replies = db.get_replies(comment_uuid)
        assert replies[0].author == db.get_default_human_author().name
        assert replies[0].author_kind == "human"

    def test_add_reply_claude_sentinel_resolves_to_default_agent(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")

        db.add_reply(comment_uuid, "a reply", author="claude")
        replies = db.get_replies(comment_uuid)
        assert replies[0].author == "claude"
        assert replies[0].author_kind == "agent"

    def test_add_reply_registered_name_resolves_directly(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")
        db.create_author("human", "Guest Reviewer")

        db.add_reply(comment_uuid, "a reply", author="Guest Reviewer")
        replies = db.get_replies(comment_uuid)
        assert replies[0].author == "Guest Reviewer"

    def test_add_reply_unregistered_name_raises(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")

        with pytest.raises(ValueError, match="Unknown author"):
            db.add_reply(comment_uuid, "a reply", author="Nobody Registered")

    def test_renaming_default_human_retroactively_updates_replies(self, temp_db: Path) -> None:
        pr_uuid = db.create_pr(
            repo_path="/repo",
            title="PR",
            base_ref="main",
            head_ref="f",
            base_commit="a",
            head_commit="b",
            diff="d",
        )
        comment_uuid = db.add_comment(pr_uuid, "file.py", 1, "a comment")
        db.add_reply(comment_uuid, "a reply", author="me")

        human = db.get_default_human_author()
        db.update_author(human.id, name="Renamed Human")

        replies = db.get_replies(comment_uuid)
        assert replies[0].author == "Renamed Human"


class TestRepoConversations:
    """Tests for repo conversation operations."""

    def test_create_repo_conversation_defaults_to_default_human(self, temp_db: Path) -> None:
        conv_uuid = db.create_repo_conversation("/repo", "file.py", 10, "first message")
        messages = db.get_repo_conversation_messages(conv_uuid)
        assert messages[0].author == db.get_default_human_author().name
        assert messages[0].author_kind == "human"

    def test_create_repo_conversation_claude_author_attributes_to_agent(
        self, temp_db: Path
    ) -> None:
        conv_uuid = db.create_repo_conversation(
            "/repo", "file2.py", 5, "claude's message", author="claude"
        )
        messages = db.get_repo_conversation_messages(conv_uuid)
        assert messages[0].author == "claude"
        assert messages[0].author_kind == "agent"

    def test_add_repo_conversation_message_claude_attributes_to_agent(self, temp_db: Path) -> None:
        conv_uuid = db.create_repo_conversation("/repo", "file3.py", 1, "human message")
        db.add_repo_conversation_message(conv_uuid, "claude's reply", author="claude")

        messages = db.get_repo_conversation_messages(conv_uuid)
        assert messages[1].author == "claude"
        assert messages[1].author_kind == "agent"

    def test_get_unanswered_conversations_uses_author_kind(self, temp_db: Path) -> None:
        conv_uuid = db.create_repo_conversation("/repo/unanswered", "file.py", 1, "a question")
        unanswered = db.get_unanswered_conversations("/repo/unanswered")
        assert any(c.uuid == conv_uuid for c, _msgs in unanswered)

        db.add_repo_conversation_message(conv_uuid, "an answer", author="claude")
        unanswered_after = db.get_unanswered_conversations("/repo/unanswered")
        assert not any(c.uuid == conv_uuid for c, _msgs in unanswered_after)
