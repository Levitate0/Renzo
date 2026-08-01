"use client";

// Shared react-query hooks for the shell chrome. Query keys are a contract:
// the downloads page reuses ["jobs"], the updates page ["updates"], settings
// ["health"] — so badges and pages share one cache and stay in sync.

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import type { Health, Job, UpdateItem } from "@/lib/types";

/** Jobs poll — 4s, the old loadJobs cadence. Powers the Downloads badge. */
export function useJobsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<Job[]>("/jobs"),
    refetchInterval: 4000,
    enabled: !!user,
  });
}

/** Updates feed — refreshed on load + every 2 min. Powers the Updates badge. */
export function useUpdatesQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["updates"],
    queryFn: () => api<UpdateItem[]>("/updates"),
    refetchInterval: 120_000,
    enabled: !!user,
  });
}

/** Service health — the topbar status line (old loadStatus). */
export function useHealthQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api<Health>("/health"),
    staleTime: 60_000,
    refetchInterval: 300_000,
    enabled: !!user,
  });
}
