"use client";

// /title/?id=<anilistId> — the old #/title/<id> page (CONTRACTS routing table).
// useSearchParams needs a <Suspense> boundary under static export; the page
// root carries the literal `view active` classes tvnav.js scopes focus to.

import { useSearchParams } from "next/navigation";
import React, { Suspense } from "react";

import AppShell from "@/components/shell/app-shell";
import { TitleDetailView } from "@/components/title/detail-view";

function TitlePageInner() {
  const params = useSearchParams();
  const id = Number(params.get("id") || 0) || 0;
  return <TitleDetailView key={id} id={id} />;
}

export default function TitlePage() {
  return (
    <AppShell>
      <div className="view active">
        <Suspense fallback={null}>
          <TitlePageInner />
        </Suspense>
      </div>
    </AppShell>
  );
}
