/**
 * Tests for the PR description's two-line clamp. The clamp itself is CSS, so
 * what's verifiable here is the decision around it: whether the toggle is
 * offered at all (only when something is actually hidden), that toggling swaps
 * the clamp class both ways, and that collapsing hides nothing from the DOM.
 *
 * jsdom does no layout, so scrollHeight/clientHeight are both 0 and every
 * description would look like it fits. Each test stubs those two to stand in
 * for "content taller than the clamp" or "content that fits".
 */
import { render, screen, fireEvent } from '@testing-library/react';

import CollapsibleDescription from '@/components/pr/CollapsibleDescription';

const LONG_DESCRIPTION = [
  'A one-line summary that survives the clamp.',
  '',
  '## Details',
  '',
  'Everything under here is what the toggle reveals.',
].join('\n');

/** Stand in for layout: how tall the body is vs. how much of it the clamp shows. */
function stubHeights(scrollHeight: number, clientHeight: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
}

const body = (container: HTMLElement) => container.querySelector('.markdown-body');
const toggle = () => screen.queryByRole('button');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CollapsibleDescription', () => {
  test('a description that fits gets no toggle and is not faded', () => {
    stubHeights(40, 40);

    const { container } = render(<CollapsibleDescription description="Short and done." />);

    expect(toggle()).toBeNull();
    // The clamp stays on - dropping it would make clientHeight report the full
    // height and oscillate - but the cut-off fade must not dim a body that's
    // entirely visible.
    expect(body(container)).toHaveClass('pr-description-clamped');
    expect(body(container)).not.toHaveClass('is-truncated');
  });

  test('a taller description starts collapsed behind a Show more toggle', () => {
    stubHeights(200, 51);

    const { container } = render(<CollapsibleDescription description={LONG_DESCRIPTION} />);

    expect(body(container)).toHaveClass('pr-description-clamped', 'is-truncated');
    expect(screen.getByRole('button', { name: /show more/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('Show more drops the clamp and turns into Show less', () => {
    stubHeights(200, 51);

    const { container } = render(<CollapsibleDescription description={LONG_DESCRIPTION} />);
    fireEvent.click(screen.getByRole('button', { name: /show more/i }));

    expect(body(container)).not.toHaveClass('pr-description-clamped');
    expect(body(container)).not.toHaveClass('is-truncated');
    expect(screen.getByRole('button', { name: /show less/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  test('Show less puts the clamp back', () => {
    stubHeights(200, 51);

    const { container } = render(<CollapsibleDescription description={LONG_DESCRIPTION} />);
    fireEvent.click(screen.getByRole('button', { name: /show more/i }));
    fireEvent.click(screen.getByRole('button', { name: /show less/i }));

    expect(body(container)).toHaveClass('pr-description-clamped');
    expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument();
  });

  test('collapsing hides the overflow visually, not from the DOM', () => {
    stubHeights(200, 51);

    render(<CollapsibleDescription description={LONG_DESCRIPTION} />);

    // Never unmounted, so find-in-page and screen readers still reach it.
    expect(screen.getByRole('heading', { name: 'Details' })).toBeInTheDocument();
    expect(screen.getByText(/what the toggle reveals/)).toBeInTheDocument();
  });

  test('a clamp that only just fits the content is not treated as overflow', () => {
    // One sub-pixel taller than the clamp - rounding, not hidden content.
    stubHeights(51, 50);

    const { container } = render(<CollapsibleDescription description={LONG_DESCRIPTION} />);

    expect(toggle()).toBeNull();
    expect(body(container)).not.toHaveClass('is-truncated');
  });
});
