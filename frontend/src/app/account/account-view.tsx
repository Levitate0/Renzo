"use client";

// /account/ — per-user settings, every role (Shiori's Account-vs-Settings
// split: /settings/ is now owner-only app config). Sections are deep-linkable
// via ?section=<account|credentials|defaults|apikey> (static export ⇒ query
// strings, no dynamic segments).
//
// Sub-nav styling copies Shiori's SectionList (section-pills.tsx): active =
// bg-primary/10 text-primary with a 2px left accent bar; inactive =
// text-muted-foreground hover:bg-accent/50 hover:text-foreground. Desktop
// shows it as a left sidebar; mobile keeps the Sheet drawer pattern the old
// settings page used.

import { ChevronDown, FolderCog, KeyRound, MonitorSmartphone, Plug, UserRound } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import React, { useState } from "react";

import { SettingsRouteShell } from "@/components/settings/route-shell";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/auth-context";
import { cn } from "@/lib/utils";

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
  const { user } = useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);

  const raw = params.get("section") || "account";
  const wanted = ALIASES[raw] ?? raw;
  const section = SECTIONS.find((s) => s.id === wanted) ?? SECTIONS[0]!;
  const Icon = section.icon;

  // Shiori SectionList treatment — active pill + left accent bar.
  const nav = (onNavigate?: () => void) => (
    <nav aria-label="Account sections" className="flex flex-col gap-1">
      {SECTIONS.map((s) => {
        const SIcon = s.icon;
        const active = s.id === section.id;
        return (
          <Link
            key={s.id}
            href={`/account/?section=${s.id}`}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {active && (
              <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
            )}
            <SIcon className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{s.label}</span>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <SettingsRouteShell
      title="Account"
      description={`Personal settings for ${user?.username ?? "your account"} — private to you.`}
    >
      {/* Mobile section picker — a Sheet mirroring the sidebar. */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetTrigger asChild>
          <Button variant="outline" className="mb-4 w-full justify-between md:hidden">
            <span className="flex items-center gap-2">
              <Icon className="h-4 w-4" />
              {section.label}
            </span>
            <ChevronDown className="h-4 w-4 opacity-60" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72">
          <SheetTitle className="mb-3 text-base">Account</SheetTitle>
          {nav(() => setSheetOpen(false))}
        </SheetContent>
      </Sheet>

      <div className="flex flex-col gap-6 md:flex-row">
        {/* Desktop sidebar */}
        <aside className="hidden w-56 shrink-0 md:block">{nav()}</aside>
        <div className="min-w-0 flex-1">{section.render()}</div>
      </div>
    </SettingsRouteShell>
  );
}
