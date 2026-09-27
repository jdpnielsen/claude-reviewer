/**
 * Tests for the stack navigator: entries render root first and indented, the
 * current PR is marked rather than linked, and a stale PR shows the restack
 * command for its parent.
 */
import { render, screen, within } from '@testing-library/react';

import type { PRData } from '@/app/prs/[id]/types';
import StackNavigator from '@/components/pr/StackNavigator';
import { PullRequestStatus } from '@/lib/enum';

type Stack = NonNullable<PRData['stack']>;

const entry = (
  uuid: string,
  base_ref: string,
  head_ref: string,
  depth: number,
  stale = false,
): Stack[number] => ({
  uuid,
  title: `PR ${uuid}`,
  status: PullRequestStatus.Pending,
  head_ref,
  base_ref,
  depth,
  stale,
});

describe('StackNavigator', () => {
  const stack: Stack = [
    entry('aaaa1111', 'main', 'feat-a', 0),
    entry('bbbb2222', 'feat-a', 'feat-b', 1),
    entry('cccc3333', 'feat-b', 'feat-c', 2, true),
  ];

  test('lists the stack in order, linking every PR but the current one', () => {
    render(<StackNavigator stack={stack} currentUuid="bbbb2222" />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('PR aaaa1111'),
      expect.stringContaining('PR bbbb2222'),
      expect.stringContaining('PR cccc3333'),
    ]);
    expect(screen.getByText('main')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'PR aaaa1111' })).toHaveAttribute(
      'href',
      '/prs/aaaa1111/stack',
    );
    expect(screen.queryByRole('link', { name: 'PR bbbb2222' })).toBeNull();
    expect(screen.getByText('PR bbbb2222')).toHaveAttribute('aria-current', 'page');
  });

  test('a stale PR shows the restack command for its parent', () => {
    render(<StackNavigator stack={stack} currentUuid="aaaa1111" />);
    const [a, b, c] = screen.getAllByRole('listitem');
    expect(within(c).getByText('claude-reviewer restack bbbb2222')).toBeInTheDocument();
    expect(within(a).queryByText(/restack/)).toBeNull();
    expect(within(b).queryByText(/restack/)).toBeNull();
  });

  test('finds the right parent in a branching stack', () => {
    const branching: Stack = [
      entry('aaaa1111', 'main', 'feat-a', 0),
      entry('bbbb2222', 'feat-a', 'feat-b', 1),
      entry('dddd4444', 'feat-b', 'feat-d', 2),
      entry('cccc3333', 'feat-a', 'feat-c', 1, true),
    ];
    render(<StackNavigator stack={branching} currentUuid="aaaa1111" />);
    expect(screen.getByText('claude-reviewer restack aaaa1111')).toBeInTheDocument();
  });
});
