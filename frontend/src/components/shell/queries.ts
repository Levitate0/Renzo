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

/**
 * Updates feed — refreshed on load + every 30 min. Powers the Updates badge.
 *
 * The interval was 2 minutes, which is the single most expensive poll in the
 * app: /updates walks up to 20 library titles through anilist.detailExtra(),
 * and each of those can spend several AniList requests chasing a season chain.
 * AniList allows 30 requests a minute, so one cold-cache /updates can exhaust
 * the whole budget on its own — and at 2 minutes it fired 30 times an hour, on
 * every open tab, against a detailExtra cache that expires hourly. New
 * episodes do not appear on a two-minute frequency; 30 minutes matches the
 * Discover rows and the server's own browse-row cache.
 */
export function useUpdatesQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["updates"],
    queryFn: () => api<UpdateItem[]>("/updates"),
    refetchInterval: 1_800_000,
    staleTime: 1_800_000,
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
