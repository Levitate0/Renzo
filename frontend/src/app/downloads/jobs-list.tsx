"use client";

// Jobs list — old loadJobs (public/app.js:1824-1899). Groups by series so a
// season batch shows as one block; per-job progress bars; queued jobs get
// "↑ Download now" (prioritize), failed ones "↻ Retry" — both only for MY jobs
// and never when staff denied me downloads. Data comes from the shared ["jobs"]
// query (4s poll, paused in background tabs), which also powers the tab badge.

import { useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Job } from "@/lib/types";

export function canRetryJob(j: Job, downloadsDenied: boolean): boolean {
  return j.status === "failed" && j.mine !== false && !downloadsDenied;
}

function ProgressTrack({ job }: { job: Job }) {
  const pct = job.status === "downloaded" ? 100 : Math.round((job.progress || 0) * 100);
  return (
    <div className="track mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
      <div
        className={cn(
          "fill h-full rounded-full transition-[width]",
          job.status === "failed" ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pct = Math.round((job.progress || 0) * 100);
  const denied = !!user?.downloadsDenied;

  const refetchJobs = () => void queryClient.invalidateQueries({ queryKey: ["jobs"] });

  const prioritize = async () => {
    setBusy(true);
    try {
      await api(`/jobs/${job.id}/prioritize`, { method: "POST" });
      toast("Moved to the front");
      refetchJobs();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    try {
      await api(`/titles/${job.titleId}/retry/${job.episode}`, { method: "POST" });
      toast("Retrying…");
      refetchJobs();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className={cn("job px-3 py-2", job.status)}>
      <div className="row flex items-center justify-between gap-2">
        <span className="name text-sm font-medium">E{job.episode}</span>
        <span className="st shrink-0 text-xs capitalize text-muted-foreground">
          {job.status}
          {job.status === "downloading" ? ` ${pct}%` : ""}
        </span>
      </div>
      {job.message ? (
        <div className="row">
          <span className="st text-xs text-muted-foreground">{job.message}</span>
        </div>
      ) : null}
      <ProgressTrack job={job} />
      {(job.status === "queued" && job.mine !== false) || canRetryJob(job, denied) ? (
        <div className="job-actions mt-1.5 flex flex-wrap gap-2">
          {job.status === "queued" && job.mine !== false && (
            <Button
              variant="outline"
              size="sm"
              className="retry-btn h-7 px-2 text-xs"
              disabled={busy}
              onClick={() => void prioritize()}
            >
              ↑ Download now
            </Button>
          )}
          {canRetryJob(job, denied) && (
            <Button
              variant="outline"
              size="sm"
              className="retry-btn h-7 px-2 text-xs"
              disabled={busy}
              onClick={() => void retry()}
            >
              ↻ Retry
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function JobsList({ jobs }: { jobs: Job[] }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const denied = !!user?.downloadsDenied;

  if (!jobs.length) {
    return (
      <div className="empty rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No downloads.
      </div>
    );
  }

  // Group by series so a season batch shows as one collapsible group.
  const groups = new Map<number, Job[]>();
  jobs.forEach((j) => {
    (groups.get(j.titleId) ?? groups.set(j.titleId, []).get(j.titleId)!).push(j);
  });

  const retryGroup = async (gjobs: Job[]) => {
    for (const j of gjobs.filter((x) => canRetryJob(x, denied))) {
      try {
        await api(`/titles/${j.titleId}/retry/${j.episode}`, { method: "POST" });
      } catch {
        /* keep going; one bad job shouldn't stop the rest */
      }
    }
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  return (
    <div id="jobsList" className="jobs grid grid-cols-1 gap-3">
      {[...groups.entries()].map(([titleId, gjobs]) => {
        const dl = gjobs.filter((j) => j.status === "downloading" || j.status === "searching").length;
        const q = gjobs.filter((j) => j.status === "queued").length;
        const failed = gjobs.filter((j) => j.status === "failed").length;
        const done = gjobs.filter((j) => j.status === "downloaded").length;
        const parts = [
          dl && `${dl} active`,
          q && `${q} queued`,
          failed && `${failed} failed`,
          done && `${done} done`,
        ].filter(Boolean) as string[];
        return (
          <div key={titleId} className="job-group overflow-hidden rounded-lg border border-border bg-card/50">
            <div className="job-group-head flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
              <span className="jg-title min-w-0 flex-1 truncate text-sm font-semibold">
                {gjobs[0]!.title}
              </span>
              <span className="jg-sum shrink-0 text-xs text-muted-foreground">
                {gjobs.length} ep{gjobs.length === 1 ? "" : "s"}
                {parts.length ? ` · ${parts.join(" · ")}` : ""}
              </span>
              {gjobs.some((j) => canRetryJob(j, denied)) && (
                <RetryGroupButton onRetry={() => retryGroup(gjobs)} />
              )}
            </div>
            <div className="divide-y divide-border/60">
              {gjobs
                .slice()
                .sort((a, b) => a.episode - b.episode)
                .map((j) => (
                  <JobRow key={j.id} job={j} />
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RetryGroupButton({ onRetry }: { onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="retry-btn h-7 shrink-0 px-2 text-xs"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onRetry().finally(() => setBusy(false));
      }}
    >
      ↻ Retry failed
    </Button>
  );
}
