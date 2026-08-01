"use client";

// /settings/?pane=<credentials|defaults|appearance|users|smtp|apikey>
// useSearchParams needs a Suspense boundary under static export (CONTRACTS).

import React, { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";

import { SettingsView } from "./settings-view";

export default function SettingsPage() {
  return (
    <AppShell>
      <Suspense fallback={<div className="view active" />}>
        <SettingsView />
      </Suspense>
    </AppShell>
  );
}
