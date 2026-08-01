"use client";

// Primary navigation — Renzo's tab set (Discover / Library / Updates /
// History / Downloads) in Shiori's pill style (section-pills.tsx look).
// The desktop container keeps the literal `tabs` class (tvnav chrome root);
// badges: Updates = updates-feed length, Downloads = active jobs (old
// #updBadge / #dlBadge). The drawer list mirrors the pills 1:1.

import { Bell, Clock3, DownloadCloud, Library, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import React from "react";

import { useJobsQuery, useUpdatesQuery } from "@/components/shell/queries";
import { cn } from "@/lib/utils";

interface TabDef {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
  live?: boolean;
}

export function useTabs(): TabDef[] {
  const { data: jobs } = useJobsQuery();
  const { data: updates } = useUpdatesQuery();
  const active =
    jobs?.filter((j) => j.status === "queued" || j.status === "searching" || j.status === "downloading")
      .length ?? 0;
  return [
    { name: "Discover", href: "/", icon: Sparkles },
    { name: "Library", href: "/library/", icon: Library },
    { name: "Updates", href: "/updates/", icon: Bell, badge: updates?.length || undefined },
    { name: "History", href: "/history/", icon: Clock3 },
    {
      name: "Downloads",
      href: "/downloads/",
      icon: DownloadCloud,
      badge: active || undefined,
      live: active > 0,
    },
  ];
}

function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname === href.slice(0, -1) || pathname.startsWith(href);
}

function Badge({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={cn(
        "badge ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums",
        active ? "bg-primary-foreground/20 text-primary-foreground" : "bg-primary/15 text-primary",
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** Desktop pill bar — carries the literal `tabs` class for tvnav. */
export function NavTabs() {
  const pathname = usePathname();
  const tabs = useTabs();
  return (
    <nav aria-label="Primary" className="tabs flex items-center gap-1 overflow-x-auto scrollbar-hide">
      {tabs.map(({ name, href, icon: Icon, badge, live }) => {
        const active = isActivePath(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="nav-ic h-4 w-4 shrink-0" />
            <span>{name}</span>
            {live && (
              <span className="relative ml-0.5 inline-flex h-1.5 w-1.5 shrink-0">
                <span
                  className={cn(
                    "absolute inset-0 inline-flex h-full w-full animate-ping rounded-full opacity-75",
                    active ? "bg-primary-foreground" : "bg-primary",
                  )}
                />
                <span
                  className={cn(
                    "relative inline-flex h-1.5 w-1.5 rounded-full",
                    active ? "bg-primary-foreground" : "bg-primary",
                  )}
                />
              </span>
            )}
            {badge ? <Badge n={badge} active={active} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Mobile drawer list — mirrors the pills (old #drawerTabs). */
export function DrawerTabs({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const tabs = useTabs();
  return (
    <nav aria-label="Primary" className="drawer-tabs flex flex-col gap-1 p-2">
      {tabs.map(({ name, href, icon: Icon, badge, live }) => {
        const active = isActivePath(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "drawer-tab relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "active bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {active && (
              <div className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-primary" />
            )}
            <Icon className="nav-ic h-5 w-5 shrink-0" />
            <span className="flex-1">{name}</span>
            {live && (
              <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
            )}
            {badge ? (
              <span className="badge inline-flex h-4 min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
