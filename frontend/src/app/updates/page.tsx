"use client";

// ---------------------------------------------------------------------------
// Updates (`/updates/`) — port of loadUpdates (public/app.js:517). Renders
// GET /api/updates as ribbon cards: "New · S#E#" for new episodes (click →
// straight into playback), "New season · S#" / "Soon" for season news and
// "Available" for movies (click → title page / playback per makeCard).
// Shares the ["updates"] query with the topbar badge (shell queries).
// ---------------------------------------------------------------------------

import { Clock, Film, LibraryBig, Play } from "lucide-react";
import React from "react";

import { type FeedEntry, FeedPage } from "@/components/media/feed";
import { AppShell } from "@/components/shell/app-shell";
import { useUpdatesQuery } from "@/components/shell/queries";
import type { CardItem, MediaType } from "@/lib/types";

function UpdatesView() {
  const updates = useUpdatesQuery();

  // Old loadUpdates: map feed items onto ribbon cards for makeCard.
  const cards: CardItem[] | undefined = updates.data?.map((u) => ({
    id: u.id,
    type: (u.type === "movie" ? "movie" : "series") as MediaType,
    title: u.title,
    poster: u.poster,
    year: u.year ?? null,
    genres: [],
    // Pass the server's adult tags through — hardcoding [] here made every
    // updates card unhideable regardless of the content level.
    content: u.content ?? [],
    updKind: u.kind,
    ep: u.ep,
    upcoming: u.upcoming,
    season: u.season,
  }));

  // Shiori's Updates feed. The feed carries no time, so it is one list
  // rather than Shiori's Today / Yesterday buckets.
  const entries: FeedEntry[] | undefined = cards?.map((c) => {
    const sTag = c.season ? `S${c.season} ` : "";
    if (c.updKind === "episode") return { item: c, icon: Play, label: `New episode · ${sTag}E${c.ep}`, accent: true, trailing: c.year ? String(c.year) : null };
    if (c.updKind === "season")
      return c.upcoming
        ? { item: c, icon: Clock, label: `Coming soon${c.season ? ` · Season ${c.season}` : ""}` }
        : { item: c, icon: LibraryBig, label: `New season${c.season ? ` · Season ${c.season}` : ""}`, accent: true };
    if (c.updKind === "movie") return { item: c, icon: Film, label: "Movie available", accent: true };
    return { item: c, icon: LibraryBig, label: "Update" };
  });

  return (
    <FeedPage
      id="view-updates"
      title="Updates"
      entries={entries}
      loading={updates.isPending}
      empty="You're all caught up — new episodes and seasons for your library show up here."
    />
  );
}

export default function UpdatesPage() {
  return (
    <AppShell>
      <UpdatesView />
    </AppShell>
  );
}
