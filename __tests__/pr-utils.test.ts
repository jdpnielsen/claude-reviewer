import { describe, expect, it } from 'vitest';

import { getCrossSideRange, getRangeTextFromDiff } from '../app/prs/[id]/utils';
import { LineType } from '../lib/enum';

describe('getRangeTextFromDiff', () => {
  const diffLines = [
    '@@ -1,4 +1,5 @@',
    ' function total(items) {',
    '-  return items.length;',
    '+  let sum = 0;',
    '+  return sum;',
    ' }',
  ];

  it('extracts new-side added lines within the range', () => {
    expect(getRangeTextFromDiff(diffLines, 2, 3, LineType.New)).toEqual([
      '  let sum = 0;',
      '  return sum;',
    ]);
  });

  it('extracts an old-side deleted line', () => {
    expect(getRangeTextFromDiff(diffLines, 2, 2, LineType.Old)).toEqual(['  return items.length;']);
  });

  it('includes unchanged context lines on the new side', () => {
    expect(getRangeTextFromDiff(diffLines, 1, 1, LineType.New)).toEqual([
      'function total(items) {',
    ]);
  });

  it('only matches deleted lines on the old side, not context lines', () => {
    // Old-side line 3 is the trailing context line " }", which only counts
    // as "new side" for matching purposes - it must not appear here.
    expect(getRangeTextFromDiff(diffLines, 2, 3, LineType.Old)).toEqual(['  return items.length;']);
  });

  it('handles multiple hunks, resetting line counters at each header', () => {
    const multiHunk = [
      '@@ -1,2 +1,2 @@',
      '-old top',
      '+new top',
      '@@ -10,2 +10,2 @@',
      '-old bottom',
      '+new bottom',
    ];
    expect(getRangeTextFromDiff(multiHunk, 10, 10, LineType.New)).toEqual(['new bottom']);
  });

  it('returns an empty array when the range is out of bounds', () => {
    expect(getRangeTextFromDiff(diffLines, 100, 101, LineType.New)).toEqual([]);
  });
});

describe('getCrossSideRange', () => {
  // idx: 0='@@ -1,4 +1,5 @@', 1=' function total(items) {',
  //      2='-  return items.length;' (old line 2), 3='+  let sum = 0;' (new line 2),
  //      4='+  return sum;' (new line 3), 5=' }'
  const diffLines = [
    '@@ -1,4 +1,5 @@',
    ' function total(items) {',
    '-  return items.length;',
    '+  let sum = 0;',
    '+  return sum;',
    ' }',
  ];

  it('pairs a single deleted line with a single added line', () => {
    expect(getCrossSideRange(diffLines, 2, 3)).toEqual({
      oldStart: 2,
      oldEnd: 2,
      newStart: 2,
      newEnd: 2,
    });
  });

  it('is bounded by the two clicked rows, not the whole block', () => {
    // Clicking the LAST added line (row 4, new line 3) and shift-clicking the
    // deleted line (row 2, old line 2) spans both added rows (2-3) but only
    // the one deleted row - it must not expand to include rows outside [2,4].
    expect(getCrossSideRange(diffLines, 4, 2)).toEqual({
      oldStart: 2,
      oldEnd: 2,
      newStart: 2,
      newEnd: 3,
    });
  });

  it('is symmetric in argument order', () => {
    expect(getCrossSideRange(diffLines, 3, 2)).toEqual(getCrossSideRange(diffLines, 2, 3));
  });

  it('returns null when a context line falls inside the span', () => {
    // Row 1 is a context line - it can't be unambiguously "old" or "new".
    expect(getCrossSideRange(diffLines, 1, 2)).toBeNull();
  });

  it('returns null when the span has no deleted line at all', () => {
    expect(getCrossSideRange(diffLines, 3, 4)).toBeNull();
  });

  it('returns null across a hunk boundary', () => {
    const multiHunk = [
      '@@ -1,2 +1,2 @@',
      '-old top',
      '+new top',
      '@@ -10,2 +10,2 @@',
      '-old bottom',
      '+new bottom',
    ];
    // The hunk header itself (row 3) breaks the pure +/- span.
    expect(getCrossSideRange(multiHunk, 1, 4)).toBeNull();
  });
});
