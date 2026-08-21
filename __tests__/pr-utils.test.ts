import { describe, expect, it } from 'vitest';

import { getRangeTextFromDiff } from '../app/prs/[id]/utils';
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
    expect(getRangeTextFromDiff(diffLines, 2, 3, LineType.Old)).toEqual([
      '  return items.length;',
    ]);
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
