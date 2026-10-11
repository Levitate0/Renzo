"use client";

// Jobs list — old loadJobs (public/app.js:1824-1899). Groups by series so a
// season batch shows as one block; per-job progress bars; queued jobs get
// "↑ Download now" (prioritize), failed ones "↻ Retry" — both only for MY jobs
// and never when staff denied me downloads. Data comes from the shared ["jobs"]
// query (4s poll, paused in background tabs), which also powers the tab badge.

import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, RotateCw } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";

import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Job } from "@/lib/types";

export function canRetryJob(j: Job, downloadsDenied: boolean): boolean {
  return j.status === "failed" && j.mine !== false && !downloadsDenied;
}

const DOT: Record<string, string> = {
  downloaded: "bg-[#31C46B]",
  failed: "bg-[#D84343]",
  downloading: "bg-[#3B8FEE]",
  searching: "bg-[#3B8FEE]",
  queued: "bg-[#EEA51F]",
};

const RANK: Record<string, number> = { downloading: 0, searching: 0, queued: 1, failed: 2, downloaded: 3 };

/** Shiori's queue filter labels, Renzo's job states. */
export const DL_FILTERS = ["All", "Downloading", "Queued", "Completed", "Failed"] as const;

function matches(j: Job, filter: number): boolean {
  switch (filter) {
    case 1:
      return j.status === "downloading" || j.status === "searching";
    case 2:
      return j.status === "queued";
    case 3:
      return j.status === "downloaded";
    case 4:
      return j.status === "failed";
    default:
      return true;
  }
}

/** Shiori's 28px icon action. */
function RowIcon({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="retry-btn ml-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/** Shiori's QueueRow, for one episode job. */
function JobRow({ job }: { job: Job }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const denied = !!user?.downloadsDenied;
  const pct = Math.round((job.progress || 0) * 100);
  const downloading = job.status === "downloading" || job.status === "searching";

  const act = async (path: string, ok: string) => {
    setBusy(true);
    try {
      await api(path, { method: "POST" });
      toast(ok);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
  };

  return (
    <div className="job relative">
      <div className="flex items-center px-3 py-3">
        <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", DOT[job.status] ?? "bg-muted-foreground")} />
        <div className="ml-3 mr-2 min-w-0 flex-1">
          <div className="flex min-w-0 items-center">
            <span className="truncate text-sm font-semibold text-foreground">{job.title}</span>
            <span className="ml-2 shrink-0 text-[13px] text-muted-foreground">E{job.episode}</span>
            {job.mine === false && <span className="ml-1 shrink-0 text-xs text-muted-foreground/70">· another user</span>}
          </div>
          {job.message && <div className="mt-0.5 truncate text-xs text-muted-foreground">{job.message}</div>}
        </div>
        <span className={cn("st shrink-0 text-xs capitalize", downloading ? "text-[#83B9F5]" : "text-muted-foreground")}>
          {job.status === "downloading" && pct > 0 ? `${pct}%` : job.status}
        </span>
        {job.status === "queued" && job.mine !== false && (
          <RowIcon icon={ArrowUp} label="Download now" disabled={busy} onClick={() => void act(`/jobs/${job.id}/prioritize`, "Moved to the front")} />
        )}
        {canRetryJob(job, denied) && (
          <RowIcon
            icon={RotateCw}
            label="Retry download"
            disabled={busy}
            onClick={() => void act(`/titles/${job.titleId}/retry/${job.episode}`, "Retrying…")}
          />
        )}
      </div>
      {downloading && (
        <div className="absolute bottom-0 left-0 h-0.5 bg-[#3B8FEE]" style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}

/** The flat queue (Shiori's queue page body), filtered and ordered. */
export function JobsList({ jobs, filter }: { jobs: Job[]; filter: number }) {
  const rows = jobs
    .filter((j) => matches(j, filter))
    .sort(
      (a, b) =>
        (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || a.title.localeCompare(b.title) || a.episode - b.episode,
    );
  if (!rows.length) {
    return (
      <p className="px-8 py-16 text-center text-xs text-muted-foreground">
        {filter === 0
          ? "No downloads. Episodes you download, or auto-download picks up, appear here."
          : `Nothing to show for “${DL_FILTERS[filter]}”.`}
      </p>
    );
  }
  return (
    <div id="jobsList" className="jobs divide-y divide-foreground/[0.04]">
      {rows.map((j) => (
        <JobRow key={j.id} job={j} />
      ))}
    </div>
  );
}
