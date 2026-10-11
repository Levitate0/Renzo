"use client";

// /account/ — per-user settings, every role (Shiori's Account-vs-Settings
// split: /settings/ is now owner-only app config). Sections are deep-linkable
// via ?section=<account|credentials|defaults|apikey> (static export ⇒ query
// strings, no dynamic segments).
//
// Laid out as Shiori's Account page, with Shiori's own SettingsSectionNav.

import { FolderCog, KeyRound, MonitorSmartphone, Plug, UserRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import React from "react";

import { SettingsRouteShell } from "@/components/settings/route-shell";
import { SettingsSectionNav } from "@/components/settings/settings-section-nav";
import { useAuth } from "@/contexts/auth-context";

import { AccountPane } from "./sections/account-pane";
import { ApiKeyPane } from "./sections/apikey-pane";
import { CredentialsPane } from "./sections/credentials-pane";
import { DefaultsPane } from "./sections/defaults-pane";
import { DevicesPane } from "./sections/devices-pane";

interface SectionDef {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  render: () => React.ReactNode;
}

const SECTIONS: SectionDef[] = [
  { id: "account", label: "Account", icon: UserRound, render: () => <AccountPane /> },
  { id: "credentials", label: "Required credentials", icon: KeyRound, render: () => <CredentialsPane /> },
  { id: "defaults", label: "Library", icon: FolderCog, render: () => <DefaultsPane /> },
  { id: "devices", label: "Devices", icon: MonitorSmartphone, render: () => <DevicesPane /> },
  { id: "apikey", label: "API key", icon: Plug, render: () => <ApiKeyPane /> },
];

// Old pane names that now live here (see the /settings/ redirect map too).
const ALIASES: Record<string, string> = {
  security: "account",
  jellyfin: "apikey",
  sessions: "devices", // paired TVs live in the same list as browser sessions
};

export function AccountView() {
  const params = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();

  const raw = params.get("section") || "account";
  const wanted = ALIASES[raw] ?? raw;
  const section = SECTIONS.find((s) => s.id === wanted) ?? SECTIONS[0]!;

  // Shiori's Account page (account/page.tsx): the section nav as a 200px
  // sidebar at lg (a drawer below), beside one section's cards. Sections stay
  // deep-linkable via ?section= — the nav writes the query string.
  return (
    <SettingsRouteShell
      title="Account"
      description={`Personal settings for ${user?.username ?? "your account"} — private to you.`}
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[200px_1fr] lg:items-start">
        <SettingsSectionNav
          sections={SECTIONS.map((s) => ({ id: s.id, title: s.label, icon: s.icon }))}
          activeId={section.id}
          onChange={(id) => router.replace(`/account/?section=${id}`)}
          drawerTitle="Account"
        />
        <div className="min-w-0 space-y-5">{section.render()}</div>
      </div>
    </SettingsRouteShell>
  );
}
