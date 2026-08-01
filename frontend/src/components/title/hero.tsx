"use client";

// Title hero — port of the top half of paintDetail (public/app.js:835-875) +
// the bound controls that follow it: banner, poster (click → lightbox), meta
// line, clamped description with "More details", Play E<next>, watchlist /
// favorite toggles, season download (gated downloadsDenied), Auto toggle,
// folder select + move, provider (release group) select and the tracking row.
// Server-only affordances are hidden when painting the offline detail page.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { ProviderOption, TitleDetail } from "@/lib/types";

import type { DetailModel } from "./detail-model";
import { TrackingRow } from "./tracking-row";

interface HeroProps {
  d: DetailModel;
  offline: boolean;
  denied: boolean;
  onPlay: (ep: number) => void;
  onOpenLightbox: (src: string) => void;
}

export function TitleHero({ d, offline, denied, onPlay, onOpenLightbox }: HeroProps) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [seasonBusy, setSeasonBusy] = useState(false);

  // Description clamp resets when navigating between seasons.
  useEffect(() => setExpanded(false), [d.id]);

  const patch = (p: Partial<TitleDetail>) => {
    qc.setQueryData<TitleDetail>(["title", d.id], (old) => (old ? { ...old, ...p } : old));
  };

  const isSeries = d.type === "series";
  // Hero Play → first not-downloaded aired episode (or E1 / movie).
  const firstEp =
    d.episodeList.find((e) => e.aired !== false && !e.hasFile) ||
    d.episodeList.find((e) => e.aired !== false) || { number: 1 };

  const inW = d.lists.includes("watchlist");
  const inF = d.lists.includes("favorites");

  const toggleList = async (listName: string) => {
    const on = !d.lists.includes(listName);
    try {
      const r = await api<{ lists: string[] }>(`/titles/${d.id}/lists`, {
        method: "POST",
        body: JSON.stringify({ list: listName, on }),
      });
      patch({ lists: r.lists });
      void qc.invalidateQueries({ queryKey: ["library"] });
      toast(on ? `Added to ${listName}` : `Removed from ${listName}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const downloadSeason = async () => {
    setSeasonBusy(true);
    toast("Queueing season…");
    try {
      const r = await api<{ queued: number }>(`/titles/${d.id}/download-season`, {
        method: "POST",
      });
      toast(
        r.queued
          ? `Queued ${r.queued} episode${r.queued === 1 ? "" : "s"}`
          : "Nothing missing — season already downloaded",
      );
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSeasonBusy(false);
    }
  };

  const toggleAuto = async () => {
    try {
      const r = await api<{ autoDownload: boolean }>(`/titles/${d.id}/auto`, {
        method: "POST",
        body: JSON.stringify({ enabled: !d.autoDownload }),
      });
      patch({ autoDownload: r.autoDownload });
      toast(
        r.autoDownload
          ? "Auto-download on — new episodes grab automatically"
          : "Auto-download off",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const meta: React.ReactNode[] = [
    <span key="type" className="type-tag">
      {d.type === "movie" ? "Movie" : "Series"}
    </span>,
  ];
  if (d.year) meta.push(<span key="year">{d.year}</span>);
  meta.push(<span key="eps">{`${d.episodesTotal || 1} ep`}</span>);
  d.genres.slice(0, 3).forEach((g, i) => meta.push(<span key={`g${i}`}>{g}</span>));

  return (
    <div className="title-hero">
      <div
        className="title-hero-bg"
        style={{ backgroundImage: `url(${d.banner || d.poster || ""})` }}
      />
      <div className="title-hero-scrim" />
      <div className="title-hero-inner">
        {d.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="title-hero-poster"
            src={d.poster}
            alt=""
            onClick={() => onOpenLightbox(d.poster)}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
          />
        ) : null}
        <div className="title-hero-meta">
          <h1 className="title-hero-name">{d.english || d.romaji}</h1>
          <div className="metaline">
            {meta.map((m, i) => (
              <React.Fragment key={i}>
                {i ? <span className="sep">•</span> : null}
                {m}
              </React.Fragment>
            ))}
          </div>
          <p className={`desc${expanded ? "" : " clamp"}`}>{d.description}</p>
          {d.description.length > 200 && (
            <button type="button" className="more-link" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Less" : "More details"}
            </button>
          )}
          <div className="detail-actions">
            <button
              type="button"
              className="tp-primary play-btn"
              onClick={() => onPlay(isSeries ? firstEp.number : 1)}
            >
              {isSeries ? `▶ Play E${firstEp.number}` : "▶ Play"}
            </button>
            {!offline && (
              <>
                <button
                  type="button"
                  className={`icon-pill${inW ? " on" : ""}`}
                  title={inW ? "In watchlist" : "Add to watchlist"}
                  onClick={() => void toggleList("watchlist")}
                >
                  {inW ? "★" : "☆"}
                </button>
                <button
                  type="button"
                  className={`icon-pill${inF ? " on" : ""}`}
                  title={inF ? "Favorited" : "Add to favorites"}
                  onClick={() => void toggleList("favorites")}
                >
                  {inF ? "♥" : "♡"}
                </button>
                {isSeries && !denied && (
                  <button
                    type="button"
                    className="icon-pill"
                    title="Download season"
                    disabled={seasonBusy}
                    onClick={() => void downloadSeason()}
                  >
                    ⬇
                  </button>
                )}
              </>
            )}
          </div>
          {!offline && (
            <div className="detail-controls">
              {isSeries && !denied && (
                <button
                  type="button"
                  className={`tp-ghost${d.autoDownload ? " on" : ""}`}
                  onClick={() => void toggleAuto()}
                >
                  {d.autoDownload ? "Auto: on" : "Auto: off"}
                </button>
              )}
              <FolderPick d={d} patch={patch} />
              <ProviderPick d={d} patch={patch} />
            </div>
          )}
          {!offline && <TrackingRow id={d.id} />}
        </div>
      </div>
    </div>
  );
}

// --- Folder select (populateFolderSelect + its change handler, app.js:1025) --
function FolderPick({
  d,
  patch,
}: {
  d: DetailModel;
  patch: (p: Partial<TitleDetail>) => void;
}) {
  const qc = useQueryClient();
  // Guarantee a real folder is always the resting selection (never "+ New…").
  const names = [...new Set([...(d.folders || []), d.folder].filter(Boolean))];
  if (!names.length) names.push("Library");
  const cur = d.folder && names.includes(d.folder) ? d.folder : names[0]!;

  const move = async (folder: string) => {
    if (folder === "__new__") {
      folder = (window.prompt("New folder name") || "").trim();
      if (!folder) return; // controlled select snaps back to `cur`
    }
    try {
      const r = await api<{ folder: string }>(`/titles/${d.id}/folder`, {
        method: "POST",
        body: JSON.stringify({ folder }),
      });
      const folders = (d.folders || []).includes(r.folder)
        ? d.folders
        : [...(d.folders || []), r.folder];
      patch({ folder: r.folder, folders });
      void qc.invalidateQueries({ queryKey: ["library"] });
      toast(`Moved to “${r.folder}”`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <label className="folder-pick" title="Folder">
      📁{" "}
      <select value={cur} onChange={(e) => void move(e.target.value)} aria-label="Folder">
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        <option value="__new__">+ New folder…</option>
      </select>
    </label>
  );
}

// --- Release-group provider picker (loadProviders, app.js:950) --------------
function ProviderPick({
  d,
  patch,
}: {
  d: DetailModel;
  patch: (p: Partial<TitleDetail>) => void;
}) {
  const q = useQuery({
    queryKey: ["title", d.id, "providers"],
    queryFn: () => api<ProviderOption[]>(`/titles/${d.id}/providers`),
    retry: false,
    staleTime: 60_000,
  });
  const providers = q.data || [];
  // If the user's saved provider isn't in the list, add it so it stays selected.
  const extra =
    d.provider && !providers.some((p) => p.group.toLowerCase() === d.provider!.toLowerCase())
      ? d.provider
      : null;

  const set = async (group: string) => {
    try {
      const r = await api<{ provider: string | null }>(`/titles/${d.id}/provider`, {
        method: "POST",
        body: JSON.stringify({ group }),
      });
      patch({ provider: r.provider });
      toast(r.provider ? `Provider set: ${r.provider}` : "Provider: Auto (best)");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <label className="folder-pick" title="Preferred release group (all episodes)">
      ▤{" "}
      <select
        value={d.provider || ""}
        onChange={(e) => void set(e.target.value)}
        aria-label="Preferred release group"
      >
        <option value="">Auto (best)</option>
        {q.isLoading && <option disabled>loading…</option>}
        {providers.map((p) => {
          const res = [...(p.resolutions || [])].sort((a, b) => b - a)[0];
          return (
            <option key={p.group} value={p.group}>
              {`${p.group}${res ? ` · ${res}p` : ""} (${p.count})`}
            </option>
          );
        })}
        {extra && <option value={extra}>{extra}</option>}
      </select>
    </label>
  );
}
