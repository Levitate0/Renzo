"use client";

// Topbar — Renzo's chrome in Shiori's command-bar style. Keeps the literal
// `topbar` class (tvnav chrome root). Layout (old index.html header):
//   [hamburger·mobile] [brand banner] [pill tabs·desktop] [search] [mode pill]
//   [status] [avatar menu]
// The mobile drawer (Sheet) mirrors the tabs; the offline bar sits above and
// the purge prompt floats — all offline chrome hides itself on TV.

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import React, { useEffect, useState } from "react";

import { AccountMenu } from "@/components/shell/account-menu";
import { DrawerTabs, NavTabs } from "@/components/shell/nav-tabs";
import { ModePill, OfflineBar, PurgePrompt } from "@/components/shell/offline-status";
import { useHealthQuery } from "@/components/shell/queries";
import { SearchBox } from "@/components/shell/search-box";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { DebridHealth } from "@/lib/types";

const RD_SHORT: Record<DebridHealth, string> = {
  premium: "RD ✓",
  "not-premium": "RD ⚠ (free)",
  connected: "RD ✓",
  "not-connected": "RD ✗",
  invalid: "RD ✗",
};

/** Service status line (old #status / loadStatus). Hidden on TV via CSS.
 *  Shows the ACTIVE debrid provider — the old app read only realdebrid, so an
 *  AllDebrid-only account permanently displayed "RD ✗" next to working playback
 *  (confirmed audit finding); /health names the resolved provider in .debrid. */
function StatusLine() {
  const { data: h, isError } = useHealthQuery();
  let text = "…";
  if (isError) text = "offline";
  else if (h) {
    const debrid =
      h.debrid === "alldebrid"
        ? (h.alldebrid === "invalid" || h.alldebrid === "not-connected" ? "AD ✗" : "AD ✓")
        : RD_SHORT[h.realdebrid] ?? "RD ✗";
    const tr = [h.trackers.anilist && "AniList", h.trackers.mal && "MAL"]
      .filter(Boolean)
      .join("+");
    text = [debrid, tr && `⇄ ${tr}`].filter(Boolean).join("  ·  ");
  }
  return (
    <div
      id="status"
      className="status hidden whitespace-nowrap text-xs text-muted-foreground min-[1800px]:block"
      title="Service status"
    >
      {text}
    </div>
  );
}

export function Topbar() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer on navigation (Shiori's command-bar behavior).
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <>
      <OfflineBar />
      <header
        className="topbar sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-xl backdrop-saturate-150"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="relative mx-auto flex h-14 w-full max-w-[1440px] items-center gap-3 px-3 lg:px-5">
          {/* Mobile hamburger -> drawer with the tab list */}
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <button
                id="navToggle"
                type="button"
                aria-label="Open menu"
                className="nav-toggle grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
              >
                <Menu className="h-5 w-5" />
              </button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="nav-drawer w-72 overflow-auto p-0"
              style={{
                paddingTop: "env(safe-area-inset-top, 0px)",
                paddingBottom: "env(safe-area-inset-bottom, 0px)",
              }}
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="nav-drawer-head flex items-center border-b border-border px-4 py-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/renzo-banner.png" alt="Renzo" className="brand-logo h-8 w-auto" />
              </div>
              <DrawerTabs onNavigate={() => setDrawerOpen(false)} />
            </SheetContent>
          </Sheet>

          {/* Brand — the byte-preserved Renzo banner (never restyled) */}
          <Link href="/" className="brand flex shrink-0 items-center" aria-label="Renzo home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/renzo-banner.png" alt="Renzo" className="brand-logo h-7 w-auto" />
          </Link>

          {/* Desktop pill tabs, centered BETWEEN brand and the right cluster by
              twin flex spacers. Shiori centers its pills absolutely in the bar,
              but Renzo's right cluster measures ~900px (search + type + mode
              pill + status + avatar) — absolute centering overlaps it at every
              width below ~2300px (user-reported at 1500-1950px). In-flow
              centering keeps the balanced look and makes overlap geometrically
              impossible: flex shrinks/scrolls the tabs instead. */}
          <div className="flex-1" />
          <div className="hidden min-w-0 shrink overflow-x-auto [scrollbar-width:none] lg:flex">
            <NavTabs />
          </div>
          <div className="flex-1" />

          <SearchBox />
          <ModePill />
          <StatusLine />
          <AccountMenu />
        </div>
      </header>
      <PurgePrompt />
    </>
  );
}
