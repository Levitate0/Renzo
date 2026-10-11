"use client";

// Auto-downloader status bar + self-check warning chips — old loadAutodl /
// #autodlBar (public/app.js:1771-1804, index.html #view-downloads). Scope
// wording ("tracked for you" vs "tracked") mirrors the backend's per-user
// numbers; "Run now" is owner-only server-side, so it renders ONLY when
// `canRun` (never offer a button that 403s). Self-check chips exist so a
// silent skip says so here — `settings:credentials` chips open that pane.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { toast } from "sonner";

import { useAuth } from "@/contexts/auth-context";
import { api, openSettings } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AutodlRunResult, AutodlStatus } from "@/lib/types";

export function useAutodlQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["autodl"],
    queryFn: () => api<AutodlStatus>("/autodl/status"),
    refetchInterval: 4000, // old loadJobs cadence (loadAutodl ran with it)
    enabled: !!user,
  });
}

/** Start an auto-download pass now (owner-only server-side). */
export function useAutodlRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<AutodlRunResult>("/autodl/run", { method: "POST" }),
    onMutate: () => toast("Auto-download pass started…"),
    onSuccess: (r) => {
      toast(`Auto-download queued ${r.queued}`);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e) => toast((e as Error).message),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["autodl"] }),
  });
}

/**
 * The auto-downloader's status as one muted line under the Downloads header —
 * where Shiori's queue shows its scan progress — plus the amber self-check
 * warnings (the credentials ones open that Account section).
 */
export function AutodlBar() {
  const { data: s } = useAutodlQuery();
  const you = s?.scope === "you";
  const checks = s?.checks || [];

  return (
    <div id="autodlBar" className="autodl space-y-1.5 px-1">
      <p id="autodlText" className="text-xs text-muted-foreground">
        {!s ? (
          "Auto-downloader…"
        ) : s.enabled ? (
          <>
            <span className="on-dot text-emerald-400">●</span> Auto-download on — every {s.intervalMin}m,{" "}
            {s.trackedTitles} {you ? "tracked for you" : "tracked"}
            {" · "}
            {s.lastRun
              ? `last run ${new Date(s.lastRun).toLocaleTimeString()} (queued ${s.lastQueued}${you ? " for you" : ""})`
              : "first run pending"}
            {s.lastError ? <span className="text-amber-400"> · ⚠ {s.lastError}</span> : null}
          </>
        ) : (
          "○ Auto-download off — set AUTO_DOWNLOAD=true in .env"
        )}
      </p>
      {checks.length > 0 && (
        <div id="autodlChecks" className="autodl-checks flex flex-col gap-1">
          {checks.map((c, i) => {
            const clickable = c.action === "settings:credentials";
            return (
              <div
                key={`${c.code}-${c.user ?? ""}-${i}`}
                className={cn(
                  "autodl-check rounded-lg border border-amber-400/25 bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-300",
                  clickable && "clickable cursor-pointer hover:bg-amber-400/20",
                )}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => openSettings("credentials") : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter") openSettings("credentials");
                      }
                    : undefined
                }
              >
                ⚠ {c.message}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
