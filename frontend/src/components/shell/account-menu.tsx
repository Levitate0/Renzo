"use client";

// Account menu — avatar with the username's initial; dropdown with the who
// header (name + role), Appearance, Settings, "Change server" (ONLY when the
// native RenzoServer plugin exists — old #serverBtn), and Log out.
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

import { LogOut, Palette, Server, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/auth-context";
import { renzoServer } from "@/lib/native";
import { useIsTv } from "@/lib/tv";
import type { Role } from "@/lib/types";

function initial(name?: string): string {
  return (name || "·").trim().charAt(0).toUpperCase() || "·";
}

const roleLabel = (r?: Role) =>
  r === "owner" ? "Owner" : r === "manager" ? "Manager" : "User";

const AVATAR_CLS =
  "avatar avatar-btn grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary/80 to-primary text-sm font-bold text-primary-foreground hover:brightness-110";

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
  const [tvOpen, setTvOpen] = useState(false);
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
          {initial(user?.username)}
        </button>
        {tvOpen && (
          <div className="acct-menu absolute right-0 top-[44px] z-50 w-52 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            <div className="who border-b border-border px-2 pb-2 pt-1.5">
              <div className="n truncate text-sm font-semibold">{user?.username ?? "—"}</div>
              <div className="r text-xs text-muted-foreground">{roleLabel(user?.role)}</div>
            </div>
            <div className="mt-1">
              <TvMenuItem onClick={() => go("/settings/?pane=appearance")}>
                <Palette className="mr-2 h-4 w-4" /> Appearance
              </TvMenuItem>
              <TvMenuItem onClick={() => go("/settings/")}>
                <Settings className="mr-2 h-4 w-4" /> Settings
              </TvMenuItem>
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
            {initial(user?.username)}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="acct-menu w-52">
          <DropdownMenuLabel className="who">
            <div className="n truncate font-semibold">{user?.username ?? "—"}</div>
            <div className="r text-xs font-normal text-muted-foreground">
              {roleLabel(user?.role)}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => router.push("/settings/?pane=appearance")}>
            <Palette className="mr-2 h-4 w-4" /> Appearance
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => router.push("/settings/")}>
            <Settings className="mr-2 h-4 w-4" /> Settings
          </DropdownMenuItem>
          {canChangeServer && (
            <DropdownMenuItem onSelect={() => void changeServer()}>
              <Server className="mr-2 h-4 w-4" /> Change server
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => void logout()}
          >
            <LogOut className="mr-2 h-4 w-4" /> Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
