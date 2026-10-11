"use client";

// Per-title tracking row (AniList/MAL status, progress, score + Sync) —
// port of loadTracking + #trackSave (public/app.js:978-1013). Display prefers
// AniList's values; a key present in the response means that tracker is
// connected. Never rendered offline (parent hides it).

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { Tracking } from "@/lib/types";

const STATUS_OPTIONS: Array<[string, string]> = [
  ["", "— Not tracked —"],
  ["watching", "Watching"],
  ["completed", "Completed"],
  ["planning", "Plan to watch"],
  ["paused", "Paused"],
  ["dropped", "Dropped"],
  ["rewatching", "Rewatching"],
];

export function TrackingRow({ id }: { id: number }) {
  const q = useQuery({
    queryKey: ["title", id, "tracking"],
    queryFn: () => api<Tracking>(`/titles/${id}/tracking`),
    retry: false,
  });

  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState("");
  const [score, setScore] = useState("");
  const [saving, setSaving] = useState(false);

  const t = q.data;
  const providers: string[] = [];
  if (t && "anilist" in t) providers.push("AniList");
  if (t && "mal" in t) providers.push("MyAnimeList");
  if (t && "kitsu" in t) providers.push("Kitsu");
  const connected = providers.length > 0;

  // Prefer AniList's values for display (old loadTracking).
  useEffect(() => {
    if (!t) return;
    const e = t.anilist || t.mal || t.kitsu || null;
    setStatus(e?.status || "");
    setProgress(String(e?.progress ?? 0));
    setScore(e?.score ? String(e.score) : "");
  }, [t]);

  const total = (t && (t.anilist || t.mal || t.kitsu)?.total) || null;
  const note = q.isError
    ? ""
    : !t
      ? ""
      : connected
        ? `Syncs to ${providers.join(" + ")}`
        : "Connect AniList, MAL or Kitsu in Settings to track";

  const sync = async () => {
    const body: { progress: number; status?: string; score?: number } = {
      progress: Number(progress) || 0,
    };
    if (status) body.status = status;
    if (score !== "") body.score = Number(score);
    setSaving(true);
    try {
      await api(`/titles/${id}/tracking`, { method: "POST", body: JSON.stringify(body) });
      toast("Tracking synced");
      await q.refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !connected;

  // Shiori's tracker dialog form (series-tracking-button.tsx): status, then
  // progress + score side by side, then Sync. Rendered inside the hero's
  // Track dialog. The select stays native — tvnav drives native selects.
  const field =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div className="track-row grid grid-cols-1 gap-4">
      <div className="space-y-2">
        <Label htmlFor="trackStatus">Status</Label>
        <select
          id="trackStatus"
          className={`track-sel ${field} [&>option]:bg-popover`}
          value={connected ? status : ""}
          disabled={disabled}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Tracking status"
        >
          {STATUS_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="trackProgress">Progress{connected && total ? ` (of ${total})` : ""}</Label>
          <input
            id="trackProgress"
            className={`track-num ${field}`}
            type="number"
            min={0}
            title="Episodes watched"
            value={connected ? progress : ""}
            disabled={disabled}
            onChange={(e) => setProgress(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="trackScore">Score</Label>
          <input
            id="trackScore"
            className={`track-num ${field}`}
            type="number"
            min={0}
            max={10}
            placeholder="/10"
            title="Score out of 10"
            value={connected ? score : ""}
            disabled={disabled}
            onChange={(e) => setScore(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={disabled || saving} onClick={() => void sync()}>
          {saving ? "Syncing…" : "Sync"}
        </Button>
        <span className="track-note text-xs text-muted-foreground">{note}</span>
      </div>
    </div>
  );
}
