import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Conversation, TreeNode } from '@/app/browse/types';
import { apiClient, buildQuery } from '@/lib/api-client';

export interface BrowseTreeResponse {
  tree: TreeNode;
  repoPath: string;
  currentPath: string;
}

export interface BrowseFileResponse {
  content: string;
  lines: string[];
  totalLines: number;
  startLine: number;
  endLine: number;
  conversations: Conversation[];
  commit: string;
}

export const browseTreeQueryKey = (repo: string) => ['browse-tree', repo] as const;

// Fetches the tree rooted at the repo (depth 2). Nested folders are lazy
// loaded on expand via useLoadFolderChildrenMutation below, which splices
// its result into this query's cache rather than being its own query - the
// tree is conceptually one piece of client state, incrementally filled in.
export function useBrowseTreeQuery(repo: string) {
  return useQuery({
    queryKey: browseTreeQueryKey(repo),
    queryFn: () =>
      apiClient.get<BrowseTreeResponse>(
        `/api/browse/tree${buildQuery({ repo, path: '', depth: 2 })}`,
      ),
    enabled: !!repo,
  });
}

// Fetches a folder's children (depth 2 from that folder) and merges them
// into the cached root tree at the matching path. Modeled as a mutation
// rather than a query since it's an imperative "fetch more and splice in"
// action triggered on folder expand, not a piece of state with its own
// independent identity.
export function useLoadFolderChildrenMutation(repo: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (folderPath: string) =>
      apiClient.get<BrowseTreeResponse>(
        `/api/browse/tree${buildQuery({ repo, path: folderPath, depth: 2 })}`,
      ),
    onSuccess: (data, folderPath) => {
      if (!data.tree?.children) return;

      queryClient.setQueryData<BrowseTreeResponse>(browseTreeQueryKey(repo), (prev) => {
        if (!prev?.tree) return prev;

        const updateNode = (node: TreeNode): TreeNode => {
          if (node.path === folderPath) {
            return { ...node, children: data.tree.children };
          }
          if (node.children) {
            return { ...node, children: node.children.map(updateNode) };
          }
          return node;
        };

        return { ...prev, tree: updateNode(prev.tree) };
      });
    },
  });
}

export const browseFileQueryKey = (repo: string, path: string) =>
  ['browse-file', repo, path] as const;

// Polls every 2s while a file is selected so newly-arrived conversations and
// anchor relocation (done server-side in the file route) stay current -
// matches the polling loop this replaces, which re-fetched the same route.
export function useBrowseFileQuery(repo: string, path: string | null) {
  return useQuery({
    queryKey: browseFileQueryKey(repo, path ?? ''),
    queryFn: () =>
      apiClient.get<BrowseFileResponse>(
        `/api/browse/file${buildQuery({ repo, path: path ?? '' })}`,
      ),
    enabled: !!repo && !!path,
    refetchInterval: 2000,
  });
}
