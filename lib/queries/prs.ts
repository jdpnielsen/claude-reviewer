import { useQuery } from '@tanstack/react-query';

import { apiClient, buildQuery } from '@/lib/api-client';
import type { PullRequestStatus } from '@/lib/enum';

export interface PullRequest {
  uuid: string;
  repo_path: string;
  title: string;
  description: string;
  base_ref: string;
  head_ref: string;
  status: PullRequestStatus;
  created_at: string;
  updated_at: string;
}

export const prsQueryKey = (status: string) => ['prs', { status }] as const;

export function usePRsQuery(status: string) {
  return useQuery({
    queryKey: prsQueryKey(status),
    queryFn: () =>
      apiClient.get<{ prs: PullRequest[] }>(
        `/api/prs${buildQuery({
          limit: 50,
          // 'default' and 'all' are virtual filters (no single status); every
          // other value is a real status matched exactly.
          status: status === 'all' || status === 'default' ? undefined : status,
          // 'default' hides closed PRs; 'all' includes them (and 'closed' shows
          // only closed).
          excludeClosed: status === 'default' ? true : undefined,
        })}`,
      ),
  });
}
