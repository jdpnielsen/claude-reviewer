/**
 * Tests for the PR header's action buttons, in particular how they degrade when
 * the PR's checkout is gone (see isRepoAvailable in lib/git.ts). Sync and AI
 * Review both shell out to git in the repo, so they have to be disabled; Close
 * is database-only and must stay usable.
 */
import { render, screen } from '@testing-library/react';
import { GitPullRequest } from 'lucide-react';

import type { PullRequest } from '@/app/prs/[id]/types';
import PRHeader from '@/components/pr/PRHeader';
import { PullRequestStatus } from '@/lib/enum';

const basePR: PullRequest = {
  id: 1,
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

function renderHeader(repoAvailable: boolean) {
  return render(
    <PRHeader
      pr={basePR}
      config={{ icon: GitPullRequest, color: '#1f6feb', label: 'Pending' }}
      requestingAI={false}
      statusChanging={false}
      syncing={false}
      repoAvailable={repoAvailable}
      onRequestAIReview={() => {}}
      onClose={() => {}}
      onReopen={() => {}}
      onSync={() => {}}
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
  });

  test('the git-backed actions are disabled once the repo is gone', () => {
    renderHeader(false);

    expect(button('Sync')).toBeDisabled();
    expect(button('AI Review')).toBeDisabled();
    // Explains itself rather than just going dead.
    expect(button('Sync').title).toContain('no longer exists');
    expect(button('AI Review').title).toContain('no longer exists');
  });

  test('Close stays available with the repo gone - it is DB-only', () => {
    renderHeader(false);

    expect(button('Close')).toBeEnabled();
  });
});
