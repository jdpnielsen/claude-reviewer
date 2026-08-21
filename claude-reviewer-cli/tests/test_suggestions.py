"""Tests for the suggestions module."""

from __future__ import annotations

from claude_reviewer.suggestions import ProseSegment, SuggestionSegment, parse_comment


def test_no_fence_returns_a_single_prose_segment() -> None:
    assert parse_comment("Just a plain comment, no suggestion here.") == [
        ProseSegment(text="Just a plain comment, no suggestion here.")
    ]


def test_fence_only() -> None:
    content = "```suggestion\ndef fixed():\n    pass\n```"
    assert parse_comment(content) == [SuggestionSegment(lines=["def fixed():", "    pass"])]


def test_prose_before_fence() -> None:
    content = "This is off by one.\n\n```suggestion\nfor i in range(n - 1):\n```"
    assert parse_comment(content) == [
        ProseSegment(text="This is off by one."),
        SuggestionSegment(lines=["for i in range(n - 1):"]),
    ]


def test_prose_after_fence_is_kept() -> None:
    content = "```suggestion\nfixed_line()\n```\n\nAlso please add a test."
    assert parse_comment(content) == [
        SuggestionSegment(lines=["fixed_line()"]),
        ProseSegment(text="Also please add a test."),
    ]


def test_multiple_fences_become_separate_ordered_segments() -> None:
    content = (
        "First one.\n\n```suggestion\nfirst()\n```\n\n"
        "And a second.\n\n```suggestion\nsecond()\n```"
    )
    assert parse_comment(content) == [
        ProseSegment(text="First one."),
        SuggestionSegment(lines=["first()"]),
        ProseSegment(text="And a second."),
        SuggestionSegment(lines=["second()"]),
    ]


def test_omits_empty_prose_segment_between_adjacent_fences() -> None:
    content = "```suggestion\nfirst()\n```\n\n```suggestion\nsecond()\n```"
    assert parse_comment(content) == [
        SuggestionSegment(lines=["first()"]),
        SuggestionSegment(lines=["second()"]),
    ]


def test_empty_suggestion_deletes_the_range() -> None:
    content = "Just delete this line.\n\n```suggestion\n```"
    assert parse_comment(content) == [
        ProseSegment(text="Just delete this line."),
        SuggestionSegment(lines=[]),
    ]


def test_multiline_suggestion_preserves_indentation() -> None:
    content = "```suggestion\nif x:\n    return 1\nelse:\n    return 2\n```"
    assert parse_comment(content) == [
        SuggestionSegment(lines=["if x:", "    return 1", "else:", "    return 2"])
    ]


def test_empty_content_returns_no_segments() -> None:
    assert parse_comment("") == []
