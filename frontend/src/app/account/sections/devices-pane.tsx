"use client";

// Devices pane — every session signed in to this account, with a per-row
// revoke (docs/TV-PAIRING-RENZO.md §5). A paired TV in a shared room stays
// signed in indefinitely by design, so seeing and killing that credential is
// the other half of the pairing feature, not a nice-to-have.
//
// GET /api/account/sessions returns an opaque sha256-derived `id`, never the
// session token — so a row can be rendered and revoked without a live
// credential ever reaching the page.
//
// Note the neighbouring rule in account-pane.tsx: changing the password also
// revokes every OTHER session. This pane is the surgical version.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Monitor, MonitorSmartphone, Smartphone, Trash2, Tv } from "lucide-react";
import Link from "next/link";
import React, { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { listSessions, revokeSession } from "@/lib/api";
import type { DeviceSession } from "@/lib/types";
import { cn } from "@/lib/utils";

import { errMsg, PaneSection } from "@/components/settings/shared";

// --- formatting -------------------------------------------------------------
// Timestamps arrive as ISO strings (Date also takes epoch ms, which is why the
// DTO allows both) — anything unparseable degrades to an em dash rather than
// printing "Invalid Date" at the user.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now" / "12 min ago" / "3 h ago" / "5 days ago" / a date. */
function relTime(v: string | number | undefined): string {
  if (v === undefined || v === null) return "—";
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return "—";
  const d = Date.now() - t;
  if (d < 0 || d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 7 * DAY) {
    const days = Math.floor(d / DAY);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  return new Date(t).toLocaleDateString();
}

function absDate(v: string | number | undefined): string {
  if (v === undefined || v === null) return "—";
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toLocaleDateString() : "—";
}

/** Ordinary browser logins carry no device name (only pairing sends one), so
 *  they get a generic label rather than an accusatory "Unnamed device". */
const deviceLabel = (s: DeviceSession): string =>
  s.deviceName || (s.current ? "This browser" : "Browser session");

/** Rough icon from the name the device supplied — cosmetic only. */
function deviceIcon(name: string | null) {
  if (!name) return Monitor; // no name = a browser login, not a paired device
  const n = name.toLowerCase();
  if (/\btv\b|television|shield|chromecast|firestick|fire tv|roku|bravia|android tv/.test(n))
    return Tv;
  if (/phone|iphone|pixel|galaxy|android|ipad|tablet/.test(n)) return Smartphone;
  if (/mac|windows|linux|desktop|chrome|firefox|safari|edge|browser/.test(n)) return Monitor;
  return MonitorSmartphone;
}

// --- pane -------------------------------------------------------------------

export function DevicesPane() {
  const qc = useQueryClient();
  const { logout } = useAuth();
  const [busyId, setBusyId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["sessions"],
    queryFn: listSessions,
    // Cheap and worth being fresh: "last seen" is the whole reason to look.
    refetchOnWindowFocus: true,
  });

  const revoke = async (s: DeviceSession) => {
    const msg = s.current
      ? "Sign out of this browser? You'll need to sign in again here."
      : `Revoke "${deviceLabel(s)}"? It will be signed out immediately and has to be paired again.`;
    if (!window.confirm(msg)) return;
    setBusyId(s.id);
    try {
      await revokeSession(s.id);
      if (s.current) {
        // Revoking your own session IS a logout — the cookie is dead, so hand
        // over to the auth context's logout (clears caches, reloads to boot).
        await logout();
        return; // page is navigating away
      }
      toast(`${deviceLabel(s)} signed out`);
      void qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const sessions = q.data ?? [];
  // Current session first, then most recently seen.
  const rows = [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
  });

  return (
    <div className="grid grid-cols-1 gap-4">
      <PaneSection
        title={
          <span className="flex items-center gap-2">
            Devices
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {q.data ? `${rows.length} ${rows.length === 1 ? "session" : "sessions"}` : "—"}
            </span>
          </span>
        }
        sub={
          <>
            Everything signed in to your account, including paired TVs. A TV stays signed in
            until you revoke it here.
          </>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={q.isFetching}
            onClick={() => void qc.invalidateQueries({ queryKey: ["sessions"] })}
          >
            Refresh
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-2">
          {rows.map((s) => {
            const Icon = deviceIcon(s.deviceName);
            const busy = busyId === s.id;
            return (
              <div
                key={s.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5",
                  s.current ? "border-primary/40 bg-primary/5" : "border-border bg-background/40",
                )}
              >
                <div
                  className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                    s.current ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{deviceLabel(s)}</span>
                    {s.current && (
                      <span className="rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold text-primary">
                        This device
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {s.deviceName ? "Paired" : "Signed in"} {absDate(s.createdAt)} · last seen{" "}
                    {s.current ? "now" : relTime(s.lastSeenAt)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className={cn(
                    "shrink-0",
                    !s.current && "text-red-400 hover:bg-red-500/10 hover:text-red-400",
                  )}
                  title={s.current ? "Sign out of this browser" : `Revoke ${deviceLabel(s)}`}
                  onClick={() => void revoke(s)}
                >
                  {s.current ? (
                    <>
                      <LogOut className="mr-1.5 h-4 w-4" />
                      Sign out
                    </>
                  ) : (
                    <>
                      <Trash2 className="mr-1.5 h-4 w-4" />
                      Revoke
                    </>
                  )}
                </Button>
              </div>
            );
          })}

          {q.isPending && <div className="text-sm text-muted-foreground">Loading devices…</div>}
          {q.isError && !q.isPending && (
            <div className="text-sm text-muted-foreground">
              Couldn&apos;t load your devices. {errMsg(q.error)}
            </div>
          )}
          {!q.isPending && !q.isError && rows.length === 0 && (
            <div className="text-sm text-muted-foreground">No active sessions.</div>
          )}
        </div>
      </PaneSection>

      <PaneSection
        title="Pair a TV"
        sub="Sign a TV in without typing a password on the remote: start pairing on the TV, then approve the code it shows."
      >
        <div className="flex flex-wrap gap-2">
          <Button asChild className="shrink-0">
            <Link href="/tv/">Enter a TV code</Link>
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The TV displays a short code and this server&apos;s address — open that address on your
          phone, or use the button above if you&apos;re already here.
        </p>
      </PaneSection>
    </div>
  );
}
