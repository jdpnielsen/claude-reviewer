/**
 * Tests for the PR header: how its action buttons degrade when the PR's
 * checkout is gone (see isRepoAvailable in lib/git.ts) - Sync and AI Review
 * both shell out to git in the repo, so they have to be disabled; Close and
 * Delete are database-only and must stay usable, since Delete is the only way
 * such a PR can be cleared out at all - plus that the description renders as
 * markdown rather than as one flat paragraph.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { GitPullRequest } from 'lucide-react';

import type { PullRequest } from '@/app/prs/[id]/types';
import PRHeader from '@/components/pr/PRHeader';
import { PullRequestStatus } from '@/lib/enum';

const basePR: PullRequest = {
  uuid: 'abc12345',
  repo_path: '/gone/worktrees/feature',
  title: 'A PR whose worktree was removed',
  description: '',
  base_ref: 'main',
  head_ref: 'feature',
  status: PullRequestStatus.Pending,
  created_at: '2026-08-31T00:00:00Z',
  updated_at: '2026-08-31T00:00:00Z',
};

function renderHeader(
  repoAvailable: boolean,
  onDelete: () => void = () => {},
  pr: PullRequest = basePR,
) {
  return render(
    <PRHeader
      pr={pr}
      config={{ icon: GitPullRequest, color: '#1f6feb', label: 'Pending' }}
      requestingAI={false}
      statusChanging={false}
      syncing={false}
      deleting={false}
      repoAvailable={repoAvailable}
      onRequestAIReview={() => {}}
      onClose={() => {}}
      onReopen={() => {}}
      onSync={() => {}}
      onDelete={onDelete}
    />,
  );
}

const button = (name: string) => screen.getByRole('button', { name });

describe('PRHeader', () => {
  test('all actions are enabled while the repo is still there', () => {
    renderHeader(true);

    expect(button('Sync')).toBeEnabled();
    expect(button('AI Review')).toBeEnabled();
    expect(button('Close')).toBeEnabled();
    expect(button('Delete')).toBeEnabled();
  });

  test('the git-backed actions are disabled once the repo is gone', () => {
    renderHeader(false);

    expect(button('Sync')).toBeDisabled();
    expect(button('AI Review')).toBeDisabled();
    // Explains itself rather than just going dead.
    expect(button('Sync').title).toContain('no longer exists');
    expect(button('AI Review').title).toContain('no longer exists');
  });

  test('Close and Delete stay available with the repo gone - both are DB-only', () => {
    renderHeader(false);

    expect(button('Close')).toBeEnabled();
    expect(button('Delete')).toBeEnabled();
  });

  test('Delete asks the page to handle it rather than acting directly', () => {
    const onDelete = vi.fn<() => void>();
    renderHeader(false, onDelete);

    fireEvent.click(button('Delete'));

    // The confirmation lives in the page (useConfirm), so the button itself
    // only reports the intent.
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  test('the description renders as markdown, not as literal source text', () => {
    renderHeader(true, () => {}, {
      ...basePR,
      description: '## Why\n\nIt uses `flags` and a list:\n\n- one\n- two',
    });

    expect(screen.getByRole('heading', { name: 'Why' })).toBeInTheDocument();
    expect(screen.getByText('flags').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // The raw markdown must not survive as text.
    expect(screen.queryByText(/## Why/)).not.toBeInTheDocument();
  });

  test('a fenced code block in the description keeps its line breaks', () => {
    const { container } = renderHeader(true, () => {}, {
      ...basePR,
      description: 'Run it:\n\n```bash\nclaude-reviewer update abc123\n```',
    });

    // A <pre> is what preserves the newlines a plain <p> would have collapsed.
    expect(container.querySelector('.pr-description pre')).not.toBeNull();
    expect(container.textContent).toContain('claude-reviewer update abc123');
  });

  test('no description means no empty description block', () => {
    const { container } = renderHeader(true);

    expect(container.querySelector('.pr-description')).toBeNull();
  });
});
