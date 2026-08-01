"use client";

// /downloads/ — the server download queue (old #view-downloads + loadJobs).
// Shares the shell's ["jobs"] query (4s poll — react-query pauses the interval
// while the tab is in the background), so the Downloads tab badge and this
// page always agree on the active count. "Retry all failed" appears only when
// there are failed jobs I'm allowed to retry (old #retryAll).

import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AutodlBar } from "@/app/downloads/autodl-bar";
import { canRetryJob, JobsList } from "@/app/downloads/jobs-list";
import { AppShell } from "@/components/shell/app-shell";
import { useJobsQuery } from "@/components/shell/queries";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";

export default function DownloadsPage() {
  const { user } = useAuth();
  const { data: jobs } = useJobsQuery();
  const queryClient = useQueryClient();
  const [retryBusy, setRetryBusy] = useState(false);
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

  return (
    <AppShell>
      <div id="view-downloads" className="view active">
        <h2 className="text-xl font-semibold">Downloads</h2>
        <div className="mt-4 grid grid-cols-1 gap-4">
          <AutodlBar
            retrySlot={
              failed.length > 0 ? (
                <Button
                  id="retryAll"
                  variant="outline"
                  size="sm"
                  disabled={retryBusy}
                  onClick={() => void retryAll()}
                >
                  ↻ Retry all failed
                </Button>
              ) : null
            }
          />
          <JobsList jobs={jobs || []} />
        </div>
      </div>
    </AppShell>
  );
}
