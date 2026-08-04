"use client";

// ---------------------------------------------------------------------------
// Updates (`/updates/`) — port of loadUpdates (public/app.js:517). Renders
// GET /api/updates as ribbon cards: "New · S#E#" for new episodes (click →
// straight into playback), "New season · S#" / "Soon" for season news and
// "Available" for movies (click → title page / playback per makeCard).
// Shares the ["updates"] query with the topbar badge (shell queries).
// ---------------------------------------------------------------------------

import React from "react";

import { MediaGrid } from "@/components/media/media-grid";
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

  return (
    <section id="view-updates" className="view active">
      <h2 className="text-xl font-semibold tracking-tight">Updates</h2>
      <p className="view-sub mt-0.5 text-[13px] text-muted-foreground">
        New episodes &amp; seasons for the anime and movies in your library.
      </p>
      <MediaGrid
        items={cards}
        loading={updates.isPending}
        empty="You're all caught up — no new episodes or seasons."
      />
    </section>
  );
}

export default function UpdatesPage() {
  return (
    <AppShell>
      <UpdatesView />
    </AppShell>
  );
}
