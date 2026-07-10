"""Shared pytest fixtures for the claude-reviewer-cli test suite."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Iterator

import pytest

from claude_reviewer import database as db


@pytest.fixture
def temp_db() -> Iterator[Path]:
    """Create a temporary database for testing."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        db.init_db(db_path)
        original_path = db.DEFAULT_DB_PATH
        db.DEFAULT_DB_PATH = db_path  # type: ignore[misc]
        yield db_path
        db.DEFAULT_DB_PATH = original_path  # type: ignore[misc]
