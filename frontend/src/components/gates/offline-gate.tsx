"use client";

// Offline gate — the saved-downloads library. Reached two ways (old app.js):
//   * boot with the server unreachable (startOfflineMode) — Retry, no Close
//   * on demand from the mode pill (openDownloads) — Close (+ Retry if offline)
// NEVER rendered on TV (isTv() guard lives in GateHost) — TVs have no offline
// storage. Ids `offlineGate` / `offlineClose` and card class `card` are tvnav
// DOM contracts. Clicking a card navigates to the title page, which renders
// from cached metadata when offline (detail agent's contract).

import { useRouter } from "next/navigation";
import React from "react";

import { cn } from "@/lib/utils";
import { useOffline } from "@/lib/offline-react";

export function OfflineGate({
  mode,
  onClose,
  hidden = false,
}: {
  /** "boot": cold launch with no server (no Close). "manual": opened from the mode pill. */
  mode: "boot" | "manual";
  onClose?: () => void;
  /** Boot mode: stay mounted but display:none while an offline title/player is
   *  open underneath — mirrors old app.js openOfflineDetail/playOffline hiding
   *  #offlineGate and offlineBack re-showing it (tvnav `hidden` class contract). */
  hidden?: boolean;
}) {
  const router = useRouter();
  const offline = useOffline();
  const groups = offline.ready ? offline.library() : [];
  const online = offline.ready ? offline.online : true;
  const showRetry = mode === "boot" || !online;

  const open = (repId: number) => {
    onClose?.();
    router.push(`/title/?id=${repId}`);
  };

  return (
    <div
      id="offlineGate"
      className={cn(
        "offline-gate fixed inset-0 z-[90] overflow-y-auto bg-background px-4 py-4 sm:px-8",
        hidden && "hidden",
      )}
    >
      <header className="offline-gate-head flex flex-wrap items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/renzo-banner.png" alt="Renzo" className="offline-gate-logo h-8 w-auto" />
        <span className="offline-tag rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-0.5 text-xs font-semibold text-red-300">
          ● {online ? "Downloads" : "Offline"}
        </span>
        <span className="flex-1" />
        {mode === "manual" && (
          <button
            id="offlineClose"
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ✕ Close
          </button>
        )}
        {showRetry && (
          <button
            id="offlineRetry"
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Retry connection
          </button>
        )}
      </header>

      <h2 className="offline-gate-title mt-6 text-lg font-semibold">Your downloads</h2>

      {groups.length === 0 ? (
        <div className="empty mt-6 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {online
            ? "No offline downloads saved yet — use “Save offline” on an episode."
            : "You're offline and haven't saved any downloads yet."}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {groups.map((g) => (
            <div
              key={g.repId}
              className="card group cursor-pointer overflow-hidden rounded-lg border border-border bg-card"
              role="button"
              tabIndex={0}
              onClick={() => open(g.repId)}
              onKeyDown={(e) => {
                if (e.key === "Enter") open(g.repId);
              }}
            >
              <div className="relative aspect-[2/3] w-full overflow-hidden bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={g.poster || "/android-chrome-512x512.png"}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
                />
                <span className="pill absolute left-1.5 top-1.5 rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-semibold">
                  {g.seasons > 1 ? `${g.seasons} seasons` : g.type === "movie" ? "Movie" : "Series"}
                </span>
                <span
                  className="dot absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-400"
                  title="downloaded"
                />
              </div>
              <div className="cap p-2">
                <div className="t truncate text-sm font-medium">{g.title}</div>
                <div className="m text-xs text-muted-foreground">
                  {g.count} episode{g.count === 1 ? "" : "s"} saved
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
