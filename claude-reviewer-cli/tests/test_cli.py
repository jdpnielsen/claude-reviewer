"""Tests for the cli module."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import pytest
from click.testing import CliRunner
from rich.console import Console

import claude_reviewer.cli
from claude_reviewer.cli import get_local_server_pid_file, main, print_comment, stop_local_server
from claude_reviewer.models import Comment


@pytest.fixture(autouse=True)
def _disable_console_colors() -> None:
    """Disable Rich console colors during tests for consistent output."""
    original_console = claude_reviewer.cli.console
    claude_reviewer.cli.console = Console(force_terminal=False)
    yield
    claude_reviewer.cli.console = original_console


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect Path.home() so pid files land in a throwaway directory."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    return tmp_path


class TestStopLocalServer:
    """Tests for stop_local_server."""

    def test_kills_process_tracked_by_pid_file(self, fake_home: Path) -> None:
        """A locally-running server tracked by a PID file is terminated and the file is removed."""
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            start_new_session=True,
        )
        pid_file = get_local_server_pid_file(41729)
        pid_file.parent.mkdir(parents=True, exist_ok=True)
        pid_file.write_text(str(process.pid))

        try:
            assert stop_local_server(41729) is True

            deadline = time.time() + 5
            while process.poll() is None and time.time() < deadline:
                time.sleep(0.1)

            assert process.poll() is not None
            assert not pid_file.exists()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_returns_false_when_nothing_is_running(self, fake_home: Path) -> None:
        """No PID file and nothing listening on the port means nothing to stop."""
        assert stop_local_server(41799) is False


class TestStopCommand:
    """Tests for the `stop` CLI command."""

    def test_reports_stopped_when_local_server_was_running(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`stop` reports success when a local (non-Docker) server was stopped."""
        monkeypatch.setattr(
            subprocess,
            "run",
            lambda *args, **kwargs: subprocess.CompletedProcess(args, 1, stdout="", stderr=""),
        )
        monkeypatch.setattr("claude_reviewer.cli.stop_local_server", lambda port: True)

        result = CliRunner().invoke(main, ["stop"])

        assert result.exit_code == 0
        assert "Stopped" in result.output


class TestPrintComment:
    """Tests for print_comment's commit-scope display."""

    def test_shows_short_sha_for_a_commit_scoped_comment(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A comment tagged with a commit shows that commit's short SHA."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="looks good",
            commit_sha="0123456789abcdef",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "a.py:1 [0123456]" in output

    def test_omits_commit_tag_for_a_cumulative_comment(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A comment with no commit_sha (cumulative view) shows no commit tag."""
        comment = Comment(
            id=1,
            uuid="abc12345",
            pr_id=1,
            file_path="a.py",
            line_number=1,
            end_line_number=1,
            content="looks good",
        )

        print_comment(comment)

        output = capsys.readouterr().out
        assert "a.py:1  ·" in output
