"use client";

// Settings — routed page at /settings/?pane=<name> (old #/settings[/pane]
// modal, now a full page per CONTRACTS routing). Desktop: left sidebar nav;
// mobile: a Sheet with the same pane list (Shiori's drawer pattern).
//
// Pane names are the CONTRACTS set (credentials|defaults|appearance|users|
// smtp|apikey) plus the "account" default; old hash pane names keep working
// via aliases (security→account, email→smtp, jellyfin→apikey).

import {
  ChevronDown,
  FolderCog,
  KeyRound,
  Mail,
  Palette,
  Plug,
  UserRound,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/auth-context";
import { cn } from "@/lib/utils";

import { AccountPane } from "./panes/account-pane";
import { ApiKeyPane } from "./panes/apikey-pane";
import { AppearancePane, useThemeSeed } from "./panes/appearance-pane";
import { CredentialsPane } from "./panes/credentials-pane";
import { DefaultsPane } from "./panes/defaults-pane";
import { SmtpPane } from "./panes/smtp-pane";
import { UsersPane } from "./panes/users-pane";

interface PaneDef {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** "staff" = owner+manager, "owner" = owner only (old usersNavBtn/emailNavBtn). */
  gate?: "staff" | "owner";
  render: () => React.ReactNode;
}

const PANES: PaneDef[] = [
  { id: "account", label: "Account", icon: UserRound, render: () => <AccountPane /> },
  { id: "credentials", label: "Required credentials", icon: KeyRound, render: () => <CredentialsPane /> },
  { id: "defaults", label: "Library", icon: FolderCog, render: () => <DefaultsPane /> },
  { id: "appearance", label: "Appearance", icon: Palette, render: () => <AppearancePane /> },
  { id: "apikey", label: "API key", icon: Plug, render: () => <ApiKeyPane /> },
  { id: "users", label: "Users", icon: Users, gate: "staff", render: () => <UsersPane /> },
  { id: "smtp", label: "Email", icon: Mail, gate: "owner", render: () => <SmtpPane /> },
];

// Old hash pane names -> new pane ids.
const ALIASES: Record<string, string> = {
  security: "account",
  email: "smtp",
  jellyfin: "apikey",
};

export function SettingsView() {
  const params = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);
  useThemeSeed(); // seed local theme from server user.theme on a fresh device

  // Leave settings — old closeModal cleared the hash, returning to the
  // previous tab (public/app.js:1906).
  const close = useCallback(() => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  }, [router]);

  // tvnav contract: the old settings was a `.modal` overlay, so RenzoTV.back()
  // matched `.modal:not(.hidden)`, dispatched Escape and consumed the press
  // (public/tvnav.js:136). The page root below carries the literal `modal`
  // class to keep that signal, and this handler is the Escape → close step —
  // unless another layer (sheet / dialog / select / popover) owns the press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper], .auth-gate:not(.hidden)',
        )
      )
        return; // that layer owns the press (Radix closes itself; gates block)
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const isOwner = user?.role === "owner";
  const isStaff = isOwner || user?.role === "manager";
  const visible = PANES.filter(
    (p) => (p.gate !== "staff" || isStaff) && (p.gate !== "owner" || isOwner),
  );

  const raw = params.get("pane") || "account";
  const wanted = ALIASES[raw] ?? raw;
  // "account" is always visible, so the fallback can never be undefined.
  const pane = visible.find((p) => p.id === wanted) ?? PANES[0]!;
  const Icon = pane.icon;

  const nav = (onNavigate?: () => void) => (
    <nav className="grid grid-cols-1 gap-1">
      {visible.map((p) => {
        const PIcon = p.icon;
        const active = p.id === pane.id;
        return (
          <Link
            key={p.id}
            href={`/settings/?pane=${p.id}`}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
              active
                ? "bg-primary/15 font-medium text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <PIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{p.label}</span>
          </Link>
        );
      })}
    </nav>
  );

  return (
    // `modal` is a tvnav marker (no styles in globals.css): Back on TV must
    // consume inside settings instead of exiting the app — see effect above.
    <div className="view active modal mx-auto w-full max-w-5xl">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

          {/* Old modal's ✕ close (public/index.html:273) — mobile keeps it on
              the title row; desktop shows it at the far right below. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close settings"
            onClick={close}
            className="sm:hidden"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Mobile pane picker — a Sheet mirroring the sidebar (Shiori pattern). */}
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="justify-between md:hidden">
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4" />
                {pane.label}
              </span>
              <ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72">
            <SheetTitle className="mb-3 text-base">Settings</SheetTitle>
            {nav(() => setSheetOpen(false))}
          </SheetContent>
        </Sheet>

        <Button
          variant="ghost"
          size="icon"
          aria-label="Close settings"
          onClick={close}
          className="hidden sm:inline-flex"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        {/* Desktop sidebar */}
        <aside className="hidden w-56 shrink-0 md:block">{nav()}</aside>
        <div className="min-w-0 flex-1">{pane.render()}</div>
      </div>
    </div>
  );
}
