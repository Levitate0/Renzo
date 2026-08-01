"use client";

// Account menu — Shiori's user-menu.tsx grouped structure, adapted to Renzo:
//
//   header: avatar + username + role pill (Medal icon; owner=primary,
//           manager=sky, user=muted — same tints as settings/shared.tsx RoleBadge)
//   ── account actions: "Edit avatar…" (avatar-dialog.tsx) + "Change password…"
//                 (small dialog → POST /api/account/password)
//   ── nav links: Users (staff) · Account (everyone) · Settings (owner) ·
//                 Change server (native shells only — old #serverBtn)
//   ── personalization: Appearance + the inline "Show up to" adult-content
//                 tier selector (same useContentLevel store as the page chips,
//                 so the two controls always agree)
//   ── Log out (red)
//
// Shiori items with NO Renzo equivalent are deliberately absent: OPDS row,
// Suwayomi import, Import Series, Take a tour, Trackers dialog
// (tracker linking lives in Account → credentials).
//
// TV: the Radix menu portals to <body>, OUTSIDE every tvnav.js root — tvnav's
// capture-phase arrow handler can't see the portalled items, so its move()
// yanks focus back to the topbar and the very first D-pad press closes the
// menu (Settings/Log out unreachable on TV). The old app's #acctMenu was an
// inline absolutely-positioned panel of plain <button>s inside `.acct` in the
// topbar (public/index.html:43, app.js:2337), which tvnav navigates
// geometrically because the topbar is one of its roots. So: Radix everywhere,
// and that same inline panel when TV mode is on — same pattern as TvSelect.
// See CONTRACTS.md "DOM contract for tvnav.js".

import {
  EyeOff,
  Image as ImageIcon,
  KeyRound,
  LogOut,
  Medal,
  Palette,
  Server,
  Settings,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  CONTENT_LADDER,
  type ContentLevel,
  useContentLevel,
} from "@/components/media/content-filter";
import { AvatarDialog } from "@/components/shell/avatar-dialog";
import { ChangePasswordDialog } from "@/components/shell/change-password-dialog";
import { UserAvatar } from "@/components/shell/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/auth-context";
import { renzoServer } from "@/lib/native";
import { useIsTv } from "@/lib/tv";
import type { PublicUser, Role } from "@/lib/types";
import { cn } from "@/lib/utils";

const roleLabel = (r?: Role) =>
  r === "owner" ? "Owner" : r === "manager" ? "Manager" : "User";

// Same tint ladder as settings/shared.tsx RoleBadge / Shiori's LEVEL_BADGE
// (dark-only app, so only the dark variants matter).
const ROLE_PILL_CLS: Record<Role, string> = {
  owner: "bg-primary/15 text-primary",
  manager: "bg-sky-500/15 text-sky-400",
  user: "bg-muted text-muted-foreground",
};

/** Role pill — Shiori's user-menu header badge, Medal icon and all. */
function RolePill({ role }: { role?: Role }) {
  return (
    <span
      className={cn(
        "role-badge inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        ROLE_PILL_CLS[role ?? "user"],
      )}
    >
      <Medal className="h-3 w-3" />
      {roleLabel(role)}
    </span>
  );
}

/** Menu header — avatar + username left, role pill inline right
 *  (user-menu.tsx:143; avatar circle mirrors the Shiori header treatment). */
function WhoHeader({ user }: { user: PublicUser | null }) {
  return (
    <div className="who mb-1 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <UserAvatar user={user} chars={2} className="h-8 w-8 text-[11px]" />
        <p className="n min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {user?.username ?? "—"}
        </p>
        <RolePill role={user?.role} />
      </div>
    </div>
  );
}

const CONTENT_LABELS: Record<ContentLevel, string> = {
  none: "Off",
  ecchi: "Ecchi",
  erotica: "Erotica",
  hentai: "Hentai",
};

/**
 * Inline adult-content quick control — the same graduated "show up to" ladder
 * as the page chips (ContentChips), reading/writing the SAME store
 * (useContentLevel), so flipping it here instantly updates every grid and the
 * chips reflect it on next look. Plain <button>s inside the menu body: Radix
 * only closes on item select, so the segment stays open while cycling (and on
 * TV the buttons are D-pad focusable inside the inline panel).
 */
function ContentTierControl() {
  const [level, setLevel] = useContentLevel();
  return (
    <div className="content-tier px-2 py-1.5">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <EyeOff className="h-4 w-4 shrink-0" />
        <span>Show up to</span>
      </div>
      <div className="flex items-center gap-1">
        {CONTENT_LADDER.map((l) => (
          <button
            key={l}
            type="button"
            title={
              l === "none"
                ? "Hide all adult content"
                : `Show up to ${CONTENT_LABELS[l]} (and everything milder)`
            }
            onClick={() => setLevel(l)}
            className={cn(
              "flex-1 cursor-pointer rounded-full border px-1.5 py-1 text-[11px] font-medium transition-colors",
              l === level
                ? "border-transparent bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:border-ring hover:text-foreground",
            )}
          >
            {CONTENT_LABELS[l]}
          </button>
        ))}
      </div>
    </div>
  );
}

// Shiori's avatar circle treatment (user-menu.tsx trigger): translucent
// primary fill + primary ring + primary initials. Keeps the literal
// `avatar avatar-btn` classes + #acctBtn id for tvnav/legacy CSS.
const AVATAR_CLS =
  "avatar avatar-btn grid shrink-0 place-items-center overflow-hidden rounded-full " +
  "border border-primary/30 bg-primary/20 text-xs font-semibold text-primary " +
  "transition-colors hover:bg-primary/30 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Inline menu row (TV) — a real <button>, natively focusable for tvnav. */
function TvMenuItem({
  className,
  children,
  onClick,
}: {
  className?: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground " +
        (className ?? "")
      }
    >
      {children}
    </button>
  );
}

export function AccountMenu() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const tv = useIsTv();
  // Role gating mirrors Shiori's user-menu (canAdmin/canOwner): staff-only and
  // owner-only entries are hidden, not disabled; the routes themselves also
  // show a NotAuthorized card for deep-linkers.
  const isOwner = user?.role === "owner";
  const isStaff = isOwner || user?.role === "manager";
  const [tvOpen, setTvOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [avOpen, setAvOpen] = useState(false);
  // Plugin presence is only knowable client-side — never show a control the
  // shell can't honour (old app checked window.Capacitor.Plugins.RenzoServer).
  const [canChangeServer, setCanChangeServer] = useState(false);
  useEffect(() => {
    setCanChangeServer(!!renzoServer());
  }, []);

  // Old app: any click outside `.acct` closes the menu (public/app.js:2341).
  useEffect(() => {
    if (!tvOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest(".acct")) setTvOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [tvOpen]);

  async function changeServer() {
    if (!window.confirm("Disconnect from this server? You'll be asked for a server address next time.")) {
      return;
    }
    try {
      await renzoServer()?.clear();
    } catch (e) {
      toast("Couldn't switch server: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (tv) {
    const go = (href: string) => {
      setTvOpen(false);
      router.push(href);
    };
    return (
      <div className="acct relative shrink-0">
        <button
          id="acctBtn"
          type="button"
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={tvOpen}
          className={AVATAR_CLS}
          style={{ width: 34, height: 34 }}
          onClick={() => setTvOpen((o) => !o)}
        >
          <UserAvatar user={user} chars={2} bare className="h-full w-full" />
        </button>
        {tvOpen && (
          <div className="acct-menu absolute right-0 top-[44px] z-50 w-60 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            <WhoHeader user={user} />
            {/* No "Change password…"/"Edit avatar…" on TV: those dialogs
                portal to <body>, outside every tvnav root, so the D-pad could
                never reach their inputs — TV users do both in /account/
                (account section), which IS navigable and hosts the same
                controls inline (AvatarEditor / password fields). */}
            <div className="mt-1">
              {isStaff && (
                <TvMenuItem onClick={() => go("/users/")}>
                  <Users className="mr-2 h-4 w-4" /> Users
                </TvMenuItem>
              )}
              {/* Account — every role: per-user settings (password/email,
                  credentials, library defaults, API key). */}
              <TvMenuItem onClick={() => go("/account/")}>
                <KeyRound className="mr-2 h-4 w-4" /> Account
              </TvMenuItem>
              {/* Settings — owner only (app-wide SMTP/Email config). */}
              {isOwner && (
                <TvMenuItem onClick={() => go("/settings/")}>
                  <Settings className="mr-2 h-4 w-4" /> Settings
                </TvMenuItem>
              )}
              {canChangeServer && (
                <TvMenuItem
                  onClick={() => {
                    setTvOpen(false);
                    void changeServer();
                  }}
                >
                  <Server className="mr-2 h-4 w-4" /> Change server
                </TvMenuItem>
              )}
            </div>
            <div className="my-1 h-px bg-border" />
            <TvMenuItem onClick={() => go("/appearance/")}>
              <Palette className="mr-2 h-4 w-4" /> Appearance
            </TvMenuItem>
            <ContentTierControl />
            <div className="my-1 h-px bg-border" />
            {/* Log out stays red/destructive — a deliberate Renzo choice
                (Shiori renders it as a neutral item; do not "fix" this). */}
            <TvMenuItem
              className="text-destructive hover:text-destructive focus:text-destructive"
              onClick={() => {
                setTvOpen(false);
                void logout();
              }}
            >
              <LogOut className="mr-2 h-4 w-4" /> Log out
            </TvMenuItem>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="acct relative shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            id="acctBtn"
            type="button"
            aria-label="Account menu"
            className={AVATAR_CLS}
            style={{ width: 34, height: 34 }}
          >
            <UserAvatar user={user} chars={2} bare className="h-full w-full" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="acct-menu w-60">
          <WhoHeader user={user} />

          {/* — account actions — */}
          <DropdownMenuItem onSelect={() => setAvOpen(true)}>
            <ImageIcon className="mr-2 h-4 w-4" /> Edit avatar…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPwOpen(true)}>
            <KeyRound className="mr-2 h-4 w-4" /> Change password…
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* — nav links — */}
          {isStaff && (
            <DropdownMenuItem onSelect={() => router.push("/users/")}>
              <Users className="mr-2 h-4 w-4" /> Users
            </DropdownMenuItem>
          )}
          {/* Account — every role: per-user settings (password/email,
              credentials, library defaults, API key). */}
          <DropdownMenuItem onSelect={() => router.push("/account/")}>
            <KeyRound className="mr-2 h-4 w-4" /> Account
          </DropdownMenuItem>
          {/* Settings — owner only (app-wide SMTP/Email config). */}
          {isOwner && (
            <DropdownMenuItem onSelect={() => router.push("/settings/")}>
              <Settings className="mr-2 h-4 w-4" /> Settings
            </DropdownMenuItem>
          )}
          {canChangeServer && (
            <DropdownMenuItem onSelect={() => void changeServer()}>
              <Server className="mr-2 h-4 w-4" /> Change server
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          {/* — personalization — */}
          <DropdownMenuItem onSelect={() => router.push("/appearance/")}>
            <Palette className="mr-2 h-4 w-4" /> Appearance
          </DropdownMenuItem>
          <ContentTierControl />

          <DropdownMenuSeparator />

          {/* Log out stays red/destructive — a deliberate Renzo choice
              (Shiori renders it as a neutral item; do not "fix" this). */}
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => void logout()}
          >
            <LogOut className="mr-2 h-4 w-4" /> Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      <AvatarDialog open={avOpen} onOpenChange={setAvOpen} />
    </div>
  );
}
