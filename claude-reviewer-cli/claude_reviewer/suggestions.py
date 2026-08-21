"""Parsing for GitHub-style suggested-change fences inside comment text.

A reviewer can propose exact replacement code for the lines a comment is
anchored to by wrapping it in a ```suggestion fenced block, e.g.:

    Looks off by one here.

    ```suggestion
    for i in range(len(items) - 1):
    ```

A comment can contain more than one fence - each "Insert suggestion" click
appends another one rather than replacing the first - so parsing splits the
content into an ordered sequence of prose and suggestion segments instead of
extracting just one.

Read-only: this module only extracts suggestions for display (in `comments`
and its `--format json` output) - the PR author (a Claude Code agent with its
own Edit tool) is expected to apply them, not the CLI.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Union

_SUGGESTION_FENCE = re.compile(
    r"^```suggestion[ \t]*\r?\n(.*?)^```[ \t]*$",
    re.DOTALL | re.MULTILINE,
)


@dataclass
class ProseSegment:
    text: str


@dataclass
class SuggestionSegment:
    lines: list[str]


CommentSegment = Union[ProseSegment, SuggestionSegment]


def parse_comment(content: str) -> list[CommentSegment]:
    """Split comment content into an ordered sequence of prose and
    ```suggestion fenced-block segments.

    A comment with no fence at all comes back as a single prose segment;
    empty prose between/around fences (or entirely empty content) is
    omitted rather than represented as an empty segment.
    """
    segments: list[CommentSegment] = []
    pos = 0

    for match in _SUGGESTION_FENCE.finditer(content):
        prose = content[pos : match.start()].strip()
        if prose:
            segments.append(ProseSegment(text=prose))

        lines = match.group(1).split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        segments.append(SuggestionSegment(lines=lines))

        pos = match.end()

    trailing = content[pos:].strip()
    if trailing:
        segments.append(ProseSegment(text=trailing))

    return segments
