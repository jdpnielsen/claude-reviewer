"""Tests for the suggestions module."""

from __future__ import annotations

from claude_reviewer.suggestions import parse_suggestion


def test_no_fence_returns_none() -> None:
    assert parse_suggestion("Just a plain comment, no suggestion here.") is None


def test_fence_only() -> None:
    content = "```suggestion\ndef fixed():\n    pass\n```"
    parsed = parse_suggestion(content)
    assert parsed is not None
    assert parsed.prose == ""
    assert parsed.lines == ["def fixed():", "    pass"]


def test_prose_before_fence() -> None:
    content = "This is off by one.\n\n```suggestion\nfor i in range(n - 1):\n```"
    parsed = parse_suggestion(content)
    assert parsed is not None
    assert parsed.prose == "This is off by one."
    assert parsed.lines == ["for i in range(n - 1):"]


def test_prose_after_fence_is_kept() -> None:
    content = "```suggestion\nfixed_line()\n```\n\nAlso please add a test."
    parsed = parse_suggestion(content)
    assert parsed is not None
    assert parsed.lines == ["fixed_line()"]
    assert "Also please add a test." in parsed.prose


def test_multiple_fences_only_first_parsed() -> None:
    content = "```suggestion\nfirst()\n```\n\n```suggestion\nsecond()\n```"
    parsed = parse_suggestion(content)
    assert parsed is not None
    assert parsed.lines == ["first()"]
    # The second fence is left inert, folded back into prose.
    assert "second()" in parsed.prose


def test_empty_suggestion_deletes_the_range() -> None:
    content = "Just delete this line.\n\n```suggestion\n```"
    parsed = parse_suggestion(content)
    assert parsed is not None
    assert parsed.lines == []


def test_multiline_suggestion_preserves_indentation() -> None:
    content = "```suggestion\nif x:\n    return 1\nelse:\n    return 2\n```"
    parsed = parse_suggestion(content)
    assert parsed is not None
    assert parsed.lines == ["if x:", "    return 1", "else:", "    return 2"]
