"use client";

// ---------------------------------------------------------------------------
// History (`/history/`) — port of loadHistory (public/app.js:145). A plain
// cover grid of GET /api/history (cards already carry per-user fields; no
// updKind, so clicking opens the title page — exactly makeCard's fallthrough).
// ---------------------------------------------------------------------------

import { useQuery } from "@tanstack/react-query";
import React from "react";

import { MediaGrid } from "@/components/media/media-grid";
import { AppShell } from "@/components/shell/app-shell";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import type { HistoryItem } from "@/lib/types";

function HistoryView() {
  const { user } = useAuth();
  const history = useQuery({
    queryKey: ["history"],
    queryFn: () => api<HistoryItem[]>("/history"),
    enabled: !!user,
  });

  return (
    <section id="view-history" className="view active">
      <h2 className="text-xl font-semibold tracking-tight">Watch history</h2>
      <p className="view-sub mt-0.5 text-[13px] text-muted-foreground">
        Recently watched — most recent first.
      </p>
      <MediaGrid
        items={history.data}
        loading={history.isPending}
        empty="Nothing watched yet — mark episodes watched or finish one in the player."
      />
    </section>
  );
}

export default function HistoryPage() {
  return (
    <AppShell>
      <HistoryView />
    </AppShell>
  );
}
