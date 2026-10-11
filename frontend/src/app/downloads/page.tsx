"use client";

// /downloads/ — the server download queue (old #view-downloads + loadJobs).
// Shares the shell's ["jobs"] query (4s poll — react-query pauses the interval
// while the tab is in the background), so the Downloads tab badge and this
// page always agree on the active count. "Retry all failed" appears only when
// there are failed jobs I'm allowed to retry (old #retryAll).

import { Play, RotateCw } from "lucide-react";
import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AutodlBar, useAutodlQuery, useAutodlRun } from "@/app/downloads/autodl-bar";
import { canRetryJob, DL_FILTERS, JobsList } from "@/app/downloads/jobs-list";
import { AppShell } from "@/components/shell/app-shell";
import { useJobsQuery } from "@/components/shell/queries";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function DownloadsPage() {
  const { user } = useAuth();
  const { data: jobs } = useJobsQuery();
  const queryClient = useQueryClient();
  const [retryBusy, setRetryBusy] = useState(false);
  const [filter, setFilter] = useState(0);
  const { data: autodl } = useAutodlQuery();
  const run = useAutodlRun();
  const denied = !!user?.downloadsDenied;

  const failed = (jobs || []).filter((j) => canRetryJob(j, denied));

  // Retry every failed download at once (old #retryAll handler).
  const retryAll = async () => {
    setRetryBusy(true);
    try {
      if (!failed.length) {
        toast("Nothing to retry");
        return;
      }
      let ok = 0;
      for (const j of failed) {
        try {
          await api(`/titles/${j.titleId}/retry/${j.episode}`, { method: "POST" });
          ok++;
        } catch {
          /* keep going; one bad job shouldn't stop the rest */
        }
      }
      toast(`Retrying ${ok} download${ok === 1 ? "" : "s"}`);
    } finally {
      setRetryBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
  };

  // Shiori's Queue page: a centred 1100px column, the filter pills, the
  // "Downloads  N" header with its pills, the auto-downloader line, the rows.
  return (
    <AppShell>
      <div id="view-downloads" className="view active">
        <div className="mx-auto w-full max-w-[1100px]">
          <div className="flex justify-center py-2">
            <div className="inline-flex flex-wrap items-center gap-1 rounded-full border border-border/60 p-1">
              {DL_FILTERS.map((label, i) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setFilter(i)}
                  aria-pressed={filter === i}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    filter === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-1 py-2">
            <h1 className="text-[22px] font-semibold text-foreground">Downloads</h1>
            <span className="ml-1 flex-1 text-sm text-muted-foreground/70">{(jobs || []).length}</span>
            {failed.length > 0 && (
              <button
                id="retryAll"
                type="button"
                disabled={retryBusy}
                onClick={() => void retryAll()}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-red-500/10 px-3 text-xs font-medium text-red-400 hover:bg-red-500/15 disabled:opacity-50"
              >
                <RotateCw className="h-3.5 w-3.5" />
                {retryBusy ? "Retrying…" : "Retry all failed"}
              </button>
            )}
            {autodl?.canRun && (
              <button
                id="autodlRun"
                type="button"
                disabled={autodl.running || run.isPending}
                onClick={() => run.mutate()}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary/10 px-3 text-xs font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {autodl.running || run.isPending ? "Running…" : "Run now"}
              </button>
            )}
          </div>

          <AutodlBar />
          <div className="mt-2">
            <JobsList jobs={jobs || []} filter={filter} />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
