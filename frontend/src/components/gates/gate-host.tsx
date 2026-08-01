"use client";

// GateHost — mounted once from layout.tsx, ABOVE the page tree. Turns the
// AuthProvider's gate state into full-screen overlays (login / first-run setup
// / password reset / invite accept / offline), exactly like the old app's
// fixed-position gates: pages always render underneath, gates sit on top.
// Also owns two app-wide event bridges:
//   * OPEN_SETTINGS_EVENT  -> routes to the settings-family page in detail.href
//                             (402 handler → /account/?section=credentials)
//   * OPEN_DOWNLOADS_EVENT -> opens the offline Downloads gate (mode pill;
//                             ignored on TV per contract)

import { usePathname, useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";

import { InviteGate } from "@/components/gates/invite-gate";
import { LoginGate } from "@/components/gates/login-gate";
import { OfflineGate } from "@/components/gates/offline-gate";
import { ResetGate } from "@/components/gates/reset-gate";
import { SetupGate } from "@/components/gates/setup-gate";
import { useAuth } from "@/contexts/auth-context";
import { OPEN_DOWNLOADS_EVENT, OPEN_SETTINGS_EVENT, settingsHref } from "@/lib/api";
import { isTv } from "@/lib/tv";

export function GateHost() {
  const { gate, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [downloadsOpen, setDownloadsOpen] = useState(false);

  // Cold-offline launch: opening a saved title/player from the Downloads gate
  // must reveal the page underneath. Old app.js hid #offlineGate in
  // openOfflineDetail (app.js:2037) / playOffline (app.js:2045) and re-showed
  // it on back (offlineBack) and on the mode pill (openDownloads, app.js:2059)
  // — here that maps to hiding the boot gate while an offline detail/watch
  // route is open, unless OPEN_DOWNLOADS_EVENT re-summons it (`downloadsOpen`);
  // clicking a card clears the summon via onClose.
  const offlineRouteOpen = pathname.startsWith("/title") || pathname.startsWith("/watch");
  const bootGateHidden = offlineRouteOpen && !downloadsOpen;

  useEffect(() => {
    const onSettings = (e: Event) => {
      const href = (e as CustomEvent<{ href?: string }>).detail?.href;
      router.push(href || settingsHref());
    };
    const onDownloads = () => {
      if (!isTv()) setDownloadsOpen(true);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
    window.addEventListener(OPEN_DOWNLOADS_EVENT, onDownloads);
    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
      window.removeEventListener(OPEN_DOWNLOADS_EVENT, onDownloads);
    };
  }, [router]);

  // Boot splash while /me resolves — prevents a flash of the empty app and a
  // burst of 401s racing the gate. Carries `auth-gate` so tvnav treats it as
  // the blocking root from the very first paint.
  if (loading) {
    return (
      <div className="auth-gate fixed inset-0 z-[100] grid place-items-center bg-background">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/renzo-banner.png" alt="Renzo" className="w-56 opacity-80" />
      </div>
    );
  }

  return (
    <>
      {gate.kind === "login" && <LoginGate />}
      {gate.kind === "setup" && <SetupGate />}
      {gate.kind === "reset" && <ResetGate token={gate.token} />}
      {gate.kind === "invite" && <InviteGate token={gate.token} />}
      {gate.kind === "offline" && !isTv() && (
        <OfflineGate
          mode="boot"
          hidden={bootGateHidden}
          onClose={() => setDownloadsOpen(false)}
        />
      )}
      {gate.kind === "none" && downloadsOpen && !isTv() && (
        <OfflineGate mode="manual" onClose={() => setDownloadsOpen(false)} />
      )}
    </>
  );
}
