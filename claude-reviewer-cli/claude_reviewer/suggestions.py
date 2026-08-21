"""Parsing for GitHub-style suggested-change fences inside comment text.

A reviewer can propose exact replacement code for the lines a comment is
anchored to by wrapping it in a ```suggestion fenced block, e.g.:

    Looks off by one here.

    ```suggestion
    for i in range(len(items) - 1):
    ```

Read-only: this module only extracts a suggestion for display (in `comments`
and its `--format json` output) - the PR author (a Claude Code agent with its
own Edit tool) is expected to apply it, not the CLI.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SUGGESTION_FENCE = re.compile(
    r"^```suggestion[ \t]*\r?\n(.*?)^```[ \t]*$",
    re.DOTALL | re.MULTILINE,
)


@dataclass
class ParsedSuggestion:
    """A comment's prose with its first ```suggestion fence extracted out."""

    prose: str
    lines: list[str]


def parse_suggestion(content: str) -> ParsedSuggestion | None:
    """Extract the first ```suggestion fenced block from comment content.

    Returns None if no such fence is present. Only the first fence is
    recognized - anything after it (including another fence) is left as
    inert prose.
    """
    match = _SUGGESTION_FENCE.search(content)
    if match is None:
        return None

    prose = (content[: match.start()] + content[match.end() :]).strip()
    lines = match.group(1).split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return ParsedSuggestion(prose=prose, lines=lines)
