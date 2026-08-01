"use client";

// Offline chrome: the sticky offline banner, the mode pill (online/offline
// indicator that opens your Downloads), and the purge-on-reconnect prompt.
// All hidden on TV (no offline features there — mode pill is display-only).

import React from "react";

import { emitAppEvent, OPEN_DOWNLOADS_EVENT } from "@/lib/api";
import { useOffline } from "@/lib/offline-react";
import { cn } from "@/lib/utils";

/** Sticky "you're offline" banner above the topbar (old #offlineBar). */
export function OfflineBar() {
  const { online, count, ready, tv } = useOffline();
  if (!ready || online || tv) return null;
  return (
    <div className="offline-bar sticky top-0 z-[70] bg-destructive/20 py-1 text-center text-xs font-semibold text-red-200">
      {count
        ? `● Offline — ${count} download${count === 1 ? "" : "s"} available`
        : "● Offline — no downloads saved"}
    </div>
  );
}

/** Topbar mode indicator — tap to open your Downloads (not on TV). */
export function ModePill() {
  const { online, ready, tv } = useOffline();
  const off = ready && !online;
  return (
    <button
      id="modePill"
      type="button"
      title="Network status · tap to open your downloads"
      onClick={() => {
        if (!tv) emitAppEvent(OPEN_DOWNLOADS_EVENT);
      }}
      className={cn(
        "mode-pill shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        off
          ? "offline border-red-400/50 bg-red-500/15 text-red-300"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {off ? "● Offline" : "● Online"}
    </button>
  );
}

/** Reconnect confirmation — never purge downloads without asking (old
 *  #offlinePurgePrompt). The offline module decides WHEN to ask. */
export function PurgePrompt() {
  const { purgePrompt, confirmPurge, keepDownloads, ready, tv } = useOffline();
  if (!ready || tv || purgePrompt == null) return null;
  return (
    <div className="purge-prompt fixed bottom-6 left-1/2 z-[120] flex w-[95vw] max-w-md -translate-x-1/2 flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xl sm:flex-row sm:items-center">
      <span className="text-sm">
        Back online — clear {purgePrompt} offline download{purgePrompt === 1 ? "" : "s"}?
      </span>
      <div className="purge-actions ml-auto flex shrink-0 gap-2">
        <button
          type="button"
          onClick={() => void keepDownloads()}
          className="rounded-md border border-border px-3.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Keep
        </button>
        <button
          type="button"
          onClick={() => void confirmPurge()}
          className="rounded-md bg-primary px-3.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Clear downloads
        </button>
      </div>
    </div>
  );
}
