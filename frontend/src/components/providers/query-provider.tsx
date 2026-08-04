"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "@/lib/api";

export default function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // matches Shiori's default
            // Never retry a dead session: the retry only 401s again, and each
            // one re-fires the forced-logout event behind the login gate.
            retry: (count, err) =>
              !(err instanceof ApiError && err.status === 401) && count < 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
