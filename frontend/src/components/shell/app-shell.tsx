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

import { Topbar } from "@/components/shell/topbar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar />
      <main className="mx-auto w-full max-w-[1440px] flex-1 overflow-x-hidden px-4 pb-16 pt-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}

export default AppShell;
