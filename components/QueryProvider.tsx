'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Errors here are almost always real API failures (bad input, 404,
            // 500), not flaky network blips - retrying them 3x by default just
            // delays the error reaching the UI.
            retry: 1,
          },
        },
        // Most call sites in this app only ever logged fetch failures to the
        // console rather than surfacing them - this restores that as the
        // default for every query/mutation. Call sites that need to show the
        // user something (alert, inline error state) add their own onError
        // on top; it runs in addition to this, not instead of it.
        queryCache: new QueryCache({
          onError: (error) => console.error(error),
        }),
        mutationCache: new MutationCache({
          onError: (error) => console.error(error),
        }),
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
