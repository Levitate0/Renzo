"use client";

// Feed — Shiori's Updates/History page form (RenzoFrontend app/updates/
// page.tsx, app/history/page.tsx): a centred max-w-[1100px] column, the
// "Updates  4" header, upper-case date-bucket labels and compact rows — a
// 40×56 cover, the title, an icon + what happened, the time on the right.
// Rows carry the literal `card` class so tvnav's D-pad picks them up, and
// click through the same openCard() the poster cards use.

import { useRouter } from "next/navigation";
import React from "react";

import { cn } from "@/lib/utils";

import type { CardItem } from "@/lib/types";
import { isHidden, useContentLevel } from "./content-filter";
import { openCard } from "./poster-card";

export interface FeedEntry {
  item: CardItem;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  accent?: boolean;
  /** Right-edge text ("3h ago"). */
  trailing?: string | null;
  /** ISO time for the date buckets; entries without one land in one list. */
  at?: string | null;
}

const BUCKETS = ["Today", "Yesterday", "This week", "Earlier"] as const;

function bucketOf(iso: string): (typeof BUCKETS)[number] {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Earlier";
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date — Shiori's formatRelativeTime. */
export function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  if (mins < 60 * 24 * 7) return `${Math.floor(mins / (60 * 24))}d ago`;
  return new Date(t).toLocaleDateString();
}

export function FeedPage({
  id,
  title,
  entries,
  loading,
  empty,
}: {
  id: string;
  title: string;
  entries: FeedEntry[] | undefined;
  loading: boolean;
  empty: string;
}) {
  const [level] = useContentLevel();
  const shown = (entries || []).filter((e) => !isHidden(e.item, level));
  const bucketed = shown.some((e) => e.at);
  const groups: [string | null, FeedEntry[]][] = bucketed
    ? BUCKETS.map((b) => [b, shown.filter((e) => (e.at ? bucketOf(e.at) : "Earlier") === b)] as [string, FeedEntry[]]).filter(
        ([, rows]) => rows.length,
      )
    : [[null, shown]];

  return (
    <section id={id} className="view active">
      <div className="mx-auto w-full max-w-[1100px] sm:pt-2">
        <div className="flex items-center px-1 pb-2">
          <h1 className="text-[22px] font-semibold text-foreground">{title}</h1>
          {!loading && <span className="ml-3 text-sm text-muted-foreground/70">{shown.length}</span>}
        </div>
        {loading && !entries ? (
          <p className="py-16 text-center text-xs text-muted-foreground">Loading…</p>
        ) : !shown.length ? (
          <p className="px-8 py-16 text-center text-xs text-muted-foreground">{empty}</p>
        ) : (
          groups.map(([label, rows]) => (
            <div key={label ?? "all"}>
              {label && (
                <div className="px-3 pb-2 pt-5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
              )}
              {rows.map((e, i) => (
                <FeedRow key={`${e.item.id}-${e.item.updKind ?? ""}-${e.item.ep ?? ""}-${i}`} entry={e} />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function FeedRow({ entry }: { entry: FeedEntry }) {
  const router = useRouter();
  const { item, icon: Icon, label, accent, trailing } = entry;
  return (
    <div
      role="button"
      aria-label={item.title}
      onClick={() => void openCard(router, item)}
      className="card flex cursor-pointer items-center rounded-lg px-3 py-2 transition-colors hover:bg-foreground/[0.04]"
    >
      <div className="h-14 w-10 shrink-0 overflow-hidden rounded-md bg-foreground/[0.04]">
        {item.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.poster} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : null}
      </div>
      <div className="ml-3 min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{item.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className={cn("h-3.5 w-3.5 shrink-0", accent ? "text-primary/80" : "")} />
          <span className="truncate">{label}</span>
        </div>
      </div>
      {trailing && <span className="ml-3 shrink-0 text-xs text-muted-foreground/70">{trailing}</span>}
    </div>
  );
}
