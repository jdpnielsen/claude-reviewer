import { groupStacks, treeGuides, type StackablePR } from '../lib/stack-grouping';

function pr(
  uuid: string,
  base: string,
  head: string,
  status = 'pending',
  repo = '/r',
): StackablePR {
  return { uuid, repo_path: repo, base_ref: base, head_ref: head, status };
}

const order = (prs: StackablePR[]) => groupStacks(prs).map(({ pr, depth }) => [pr.uuid, depth]);

describe('groupStacks', () => {
  test('moves children directly under their parent, keeping other order', () => {
    // Newest first, as the list API returns them.
    const prs = [pr('c', 'b', 'c'), pr('x', 'main', 'x'), pr('b', 'a', 'b'), pr('a', 'main', 'a')];
    expect(order(prs)).toEqual([
      ['x', 0],
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  test('handles branching stacks', () => {
    const prs = [pr('a', 'main', 'a'), pr('b', 'a', 'b'), pr('c', 'a', 'c')];
    expect(order(prs)).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 1],
    ]);
  });

  test('ignores closed/merged parents and other repos', () => {
    const prs = [
      pr('a', 'main', 'a', 'merged'),
      pr('b', 'a', 'b'),
      pr('z', 'main', 'a', 'pending', '/other'),
      pr('y', 'a', 'y', 'pending', '/other'),
    ];
    expect(order(prs)).toEqual([
      ['a', 0],
      ['b', 0],
      ['z', 0],
      ['y', 1],
    ]);
  });

  test('a PR whose parent is not in the list stays a root', () => {
    expect(order([pr('b', 'a', 'b')])).toEqual([['b', 0]]);
  });

  test('keeps every member of a branch cycle', () => {
    const prs = [pr('a', 'b', 'a'), pr('b', 'a', 'b')];
    expect(
      order(prs)
        .map(([uuid]) => uuid)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('treeGuides', () => {
  test('marks pass-through lines, last siblings and rows with children', () => {
    // a
    // ├ b
    // │ └ d
    // └ c
    expect(treeGuides([0, 1, 2, 1])).toEqual([
      { guides: [], hasChildren: true },
      { guides: [true], hasChildren: true },
      { guides: [true, false], hasChildren: false },
      { guides: [false], hasChildren: false },
    ]);
  });

  test('a chain ends every line at its last row', () => {
    expect(treeGuides([0, 1, 2]).map((g) => g.guides)).toEqual([[], [false], [false, false]]);
  });

  test('groupStacks returns the guides with each row', () => {
    const rows = groupStacks([pr('a', 'main', 'a'), pr('b', 'a', 'b'), pr('x', 'main', 'x')]);
    expect(rows.map(({ pr, guides, hasChildren }) => [pr.uuid, guides, hasChildren])).toEqual([
      ['a', [], true],
      ['b', [false], false],
      ['x', [], false],
    ]);
  });
});
