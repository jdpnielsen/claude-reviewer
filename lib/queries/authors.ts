import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '@/lib/api-client';
import type { AuthorKind } from '@/lib/enum';

export interface Author {
  id: number;
  kind: AuthorKind;
  name: string;
  email: string | null;
  isDefaultHuman: boolean;
  isDefaultAgent: boolean;
}

export interface GitSuggestion {
  name: string | null;
  email: string | null;
}

export const authorsQueryKey = ['authors'] as const;

export function useAuthorsQuery() {
  return useQuery({
    queryKey: authorsQueryKey,
    queryFn: () =>
      apiClient.get<{ authors: Author[]; gitSuggestion: GitSuggestion | null }>('/api/authors'),
  });
}

export function useUpdateAuthorMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, email }: { id: number; name: string; email: string | null }) =>
      apiClient.patch(`/api/authors/${id}`, { name, email }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authorsQueryKey }),
  });
}

export function useDeleteAuthorMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete(`/api/authors/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authorsQueryKey }),
  });
}

export function useMakeDefaultAuthorMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.post(`/api/authors/${id}/default`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authorsQueryKey }),
  });
}

export function useAddAuthorMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { name: string; kind: AuthorKind; email: string | null }) =>
      apiClient.post('/api/authors', params),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authorsQueryKey }),
  });
}
