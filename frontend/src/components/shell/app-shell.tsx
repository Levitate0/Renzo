"use client";

// AppShell — pages wrap themselves in this (CONTRACTS "shell"):
//
//   export default function Page() {
//     return (
//       <AppShell>
//         <div className="view active">…page content…</div>
//       </AppShell>
//     );
//   }
//
// IMPORTANT (tvnav contract): the page's own ROOT element must carry the
// literal classes `view active` — tvnav.js scopes D-pad focus to
// `.topbar`, `.tabs` and the `.view.active` container. AppShell provides the
// chrome; gates render above everything from layout.tsx (GateHost).

import React from "react";

import { RibbonProvider } from "@/components/shell/ribbon";
import { Topbar } from "@/components/shell/topbar";

export function AppShell({
  children,
  bleed = false,
}: {
  children: React.ReactNode;
  /** Full-bleed page (Shiori's series page): no main padding, so a hero can
   *  run edge to edge under the top bar. */
  bleed?: boolean;
}) {
  return (
    <RibbonProvider>
      <div className="flex min-h-dvh flex-col">
        <Topbar />
        {/* Full-bleed, like the Hub: the old max-w-[1440px] column left a wide
            monitor with empty gutters while the Hub's window fills edge to edge.
            The topbar drops the same cap so the two stay aligned. */}
        <main
          className={
            bleed
              ? "w-full flex-1 overflow-x-hidden pb-16"
              : "w-full flex-1 overflow-x-hidden px-4 pb-16 pt-6 sm:px-6"
          }
        >
          {children}
        </main>
      </div>
    </RibbonProvider>
  );
}

export default AppShell;
