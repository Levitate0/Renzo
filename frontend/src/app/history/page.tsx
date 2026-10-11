"use client";

// ---------------------------------------------------------------------------
// History (`/history/`) — port of loadHistory (public/app.js:145). A plain
// cover grid of GET /api/history (cards already carry per-user fields; no
// updKind, so clicking opens the title page — exactly makeCard's fallthrough).
// ---------------------------------------------------------------------------

import { useQuery } from "@tanstack/react-query";
import { History as HistoryIcon } from "lucide-react";
import React from "react";

import { type FeedEntry, FeedPage, relativeTime } from "@/components/media/feed";
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

  // Shiori's History feed, bucketed Today / Yesterday / This week / Earlier.
  const entries: FeedEntry[] | undefined = history.data?.map((h) => ({
    item: h,
    icon: HistoryIcon,
    label: `Watched E${h.ep}${h.upNext ? ` · up next E${h.upNext}` : ""}`,
    trailing: relativeTime(h.at),
    at: h.at,
  }));

  return (
    <FeedPage
      id="view-history"
      title="History"
      entries={entries}
      loading={history.isPending}
      empty="Nothing watched yet — mark episodes watched or finish one in the player."
    />
  );
}

export default function HistoryPage() {
  return (
    <AppShell>
      <HistoryView />
    </AppShell>
  );
}
