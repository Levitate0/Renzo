"use client";

// ---------------------------------------------------------------------------
// Discover (`/`, the old default tab) — port of loadBrowse/doSearch/
// showCategory (public/app.js:653-708) + the on-page content-filter chips.
// Three modes:
//   * browse   — Trending / Recommended / New & this season rows
//   * category — full wrapping grid of one row ("See all ›" / More tile)
//   * search   — results for the topbar query (shared search context); the
//                topbar already navigates here when the user types.
// Search wins over category; "‹ Back" clears search (old #discoverBack) or
// leaves the category view. Content chips sit at the top in every mode (old
// #browseContentChips) — on EVERY platform including TV, where they are plain
// <button>s that tvnav's D-pad discovery picks up.
// ---------------------------------------------------------------------------

import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import { ContentChips } from "@/components/media/content-filter";
import { BrowseRowGrid, MediaGrid } from "@/components/media/media-grid";
import { AppShell } from "@/components/shell/app-shell";
import { useAuth } from "@/contexts/auth-context";
import { useSearch } from "@/contexts/search-context";
import { api, ApiError } from "@/lib/api";
import type { CardItem } from "@/lib/types";

type CatKey = "trending" | "recommended" | "newSeason";

const CAT_LABELS: Record<CatKey, string> = {
  trending: "Trending",
  recommended: "Recommended",
  newSeason: "New & this season",
};
const CAT_URLS: Record<CatKey, string> = {
  trending: "/discover/trending",
  recommended: "/discover/recommended",
  newSeason: "/discover/new-season",
};

function useDiscoverRow(key: CatKey) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["discover", key],
    queryFn: () => api<CardItem[]>(CAT_URLS[key]),
    staleTime: 300_000,
    enabled: !!user,
  });
}

function BackHeading({ heading, onBack }: { heading: string; onBack: () => void }) {
  return (
    <div className="search-head mb-1.5 flex items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        className="rounded-full border border-border bg-card px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
      >
        ‹ Back
      </button>
      <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">{heading}</h2>
    </div>
  );
}

function DiscoverView() {
  const { user } = useAuth();
  const { active, debouncedQuery, searchType, clearSearch } = useSearch();
  const [category, setCategory] = useState<CatKey | null>(null);

  const trending = useDiscoverRow("trending");
  const recommended = useDiscoverRow("recommended");
  const newSeason = useDiscoverRow("newSeason");
  const rows: Record<CatKey, typeof trending> = { trending, recommended, newSeason };

  const q = debouncedQuery.trim();
  const search = useQuery({
    queryKey: ["discover-search", q, searchType],
    queryFn: () =>
      api<CardItem[]>(`/discover/search?q=${encodeURIComponent(q)}&type=${searchType}`),
    enabled: !!user && active,
  });

  // Typing replaces whatever was on screen (old doSearch showed searchWrap).
  useEffect(() => {
    if (active) setCategory(null);
  }, [active]);

  // Old: toast("Search failed: " + e.message); 401/402 already handled globally.
  useEffect(() => {
    const err = search.error;
    if (!err) return;
    if (err instanceof ApiError && (err.status === 401 || err.status === 402)) return;
    toast("Search failed: " + err.message);
  }, [search.error]);

  return (
    <section id="view-discover" className="view active">
      <ContentChips />

      {active ? (
        <div id="searchWrap">
          <BackHeading heading={`Results for “${q}”`} onBack={clearSearch} />
          <MediaGrid
            items={search.data}
            loading={search.isPending}
            empty="Nothing here yet."
          />
        </div>
      ) : category ? (
        <div id="searchWrap">
          <BackHeading heading={CAT_LABELS[category]} onBack={() => setCategory(null)} />
          <MediaGrid
            items={rows[category].data}
            loading={rows[category].isPending}
            empty="Nothing here yet."
          />
        </div>
      ) : (
        <div id="browseWrap" className="mt-2">
          {(Object.keys(CAT_LABELS) as CatKey[]).map((key) => (
            <BrowseRowGrid
              key={key}
              title={CAT_LABELS[key]}
              items={rows[key].data}
              loading={rows[key].isPending}
              onMore={() => {
                setCategory(key);
                window.scrollTo(0, 0);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function DiscoverPage() {
  return (
    <AppShell>
      <DiscoverView />
    </AppShell>
  );
}
