"use client";

// /appearance/ — the appearance pane as its own route, every user (mirrors
// Shiori's dedicated /appearance page). Old /settings/?pane=appearance links
// land here via the /settings/ redirect map.

import React from "react";

import { SettingsRouteShell } from "@/components/settings/route-shell";
import { AppShell } from "@/components/shell/app-shell";

import { AppearancePane } from "./appearance-pane";

export default function AppearancePage() {
  return (
    <AppShell>
      <SettingsRouteShell
        title="Appearance"
        description="Personalize how Renzo looks — saved to your account, so it follows you on every device."
      >
        <AppearancePane />
      </SettingsRouteShell>
    </AppShell>
  );
}
