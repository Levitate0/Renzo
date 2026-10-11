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

import { useQueries, useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import { type ContentLevel, isHidden, useContentLevel } from "@/components/media/content-filter";
import { BrowseRowGrid, MediaGrid } from "@/components/media/media-grid";
import { SpotlightHero, type SpotlightItem } from "@/components/media/spotlight-hero";
import { AppShell } from "@/components/shell/app-shell";
import { RibbonSlot } from "@/components/shell/ribbon";
import { TvSelect } from "@/components/ui/tv-select";
import { useAuth } from "@/contexts/auth-context";
import { useSearch } from "@/contexts/search-context";
import { api, ApiError } from "@/lib/api";
import type { CardItem, TitleDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

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
    // 30 minutes, matching the server's browse-row cache (services/anilist.ts
    // LIST_TTL_MS). At the old 5 the client re-asked six times per server
    // cache entry — every one of those a chance to land on a cold cache and
    // spend an AniList request.
    staleTime: 1_800_000,
    gcTime: 1_800_000,
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

  // Shiori's Browse: the ribbon, the spotlight over the first picks, then the
  // catalogue (here the three rows, scrolling as one page).
  return (
    <section id="view-discover" className="view active">
      <ContentRibbon />

      {active ? (
        <div id="searchWrap">
          <BackHeading heading={`Results for “${q}”`} onBack={clearSearch} />
          <MediaGrid items={search.data} loading={search.isPending} empty="Nothing here yet." hiddenNote />
        </div>
      ) : category ? (
        <div id="searchWrap">
          <BackHeading heading={CAT_LABELS[category]} onBack={() => setCategory(null)} />
          <MediaGrid items={rows[category].data} loading={rows[category].isPending} empty="Nothing here yet." />
        </div>
      ) : (
        <div id="browseWrap">
          <DiscoverSpotlight items={trending.data} />
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

const AIRING: Record<string, { label: string; color: string; ongoing?: boolean }> = {
  RELEASING: { label: "Airing", color: "#22c55e", ongoing: true },
  FINISHED: { label: "Finished", color: "#3b82f6" },
  NOT_YET_RELEASED: { label: "Upcoming", color: "#eab308" },
};

/**
 * Shiori's spotlight over the trending picks. Discover cards carry no
 * description or airing status; the title endpoint does (the server caches
 * it), so each slide fills in as its detail arrives.
 */
function DiscoverSpotlight({ items }: { items: CardItem[] | undefined }) {
  const router = useRouter();
  const [level] = useContentLevel();
  const picks = (items || []).filter((it) => it.id != null && !isHidden(it, level)).slice(0, 7);
  const details = useQueries({
    queries: picks.map((p) => ({
      queryKey: ["title", p.id],
      queryFn: () => api<TitleDetail>(`/titles/${p.id}`),
      staleTime: 1_800_000,
      retry: false,
    })),
  });
  if (!picks.length) return null;
  const slides: SpotlightItem[] = picks.map((p, i) => {
    const d = details[i]?.data;
    const st = d?.airingStatus ? AIRING[d.airingStatus.toUpperCase()] : undefined;
    const eps = d?.episodesTotal || d?.episodeCount;
    return {
      id: p.id!,
      title: p.title,
      author: p.year ? String(p.year) : undefined,
      description: d?.description ? d.description.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim() : null,
      thumbnailUrl: p.poster,
      statusLabel: st?.label ?? (p.type === "movie" ? "Movie" : "Series"),
      statusColor: st?.color ?? "#71717a",
      ongoing: st?.ongoing,
      genres: p.genres?.length ? p.genres : d?.genres,
      meta: [p.year, eps ? `${eps} episodes` : null].filter(Boolean).join(" · ") || undefined,
    };
  });
  return (
    <div className="mb-8">
      <SpotlightHero
        items={slides}
        eyebrow="TRENDING · THIS SEASON ON ANILIST"
        ctaLabel="View title"
        ctaIcon={Play}
        onCtaClick={(s) => router.push(`/title/?id=${s.id}`)}
        variant="browse"
      />
    </div>
  );
}

/** Shiori's library ribbon, Discover's share of it: the 18+ control. */
function ContentRibbon() {
  const [level, setLevel] = useContentLevel();
  const shown = level !== "none";
  return (
    <RibbonSlot>
      <div className="flex w-full items-center gap-2">
        <div
          className={cn(
            "flex shrink-0 items-center gap-1.5",
            shown && "[&_button]:border-amber-500/50 [&_button]:bg-amber-500/10 [&_button]:text-amber-400 [&_select]:border-amber-500/50 [&_select]:text-amber-400",
          )}
        >
          {shown ? <Eye className="h-4 w-4 text-amber-400" /> : <EyeOff className="h-4 w-4 text-muted-foreground" />}
          <div className="w-40">
            <TvSelect
              aria-label="18+ content"
              className="h-8 w-full !pr-2 text-xs sm:text-sm"
              value={level}
              onValueChange={(v) => setLevel(v as ContentLevel)}
              options={[
                { value: "none", label: "18+ Hidden" },
                { value: "ecchi", label: "18+ up to Ecchi" },
                { value: "erotica", label: "18+ up to Erotica" },
                { value: "hentai", label: "18+ up to Hentai" },
              ]}
            />
          </div>
        </div>
      </div>
    </RibbonSlot>
  );
}

export default function DiscoverPage() {
  return (
    <AppShell>
      <DiscoverView />
    </AppShell>
  );
}
