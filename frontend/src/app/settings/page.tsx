"use client";

// /settings/ — owner-gated app-level config: SMTP/Email is all that remains
// here after the Shiori-style IA split (per-user things moved to /account/,
// /appearance/; staff things to /users/).
//
// Back-compat: old /settings/?pane=X deep links (bookmarks, shipped native
// shells) still land correctly via a client-side redirect map — see REDIRECTS.
// useSearchParams needs a Suspense boundary under static export (CONTRACTS).

import { useRouter, useSearchParams } from "next/navigation";
import React, { Suspense, useEffect } from "react";

import { NotAuthorized } from "@/components/settings/not-authorized";
import { SettingsRouteShell } from "@/components/settings/route-shell";
import { AppShell } from "@/components/shell/app-shell";
import { useAuth } from "@/contexts/auth-context";

import { SmtpPane } from "./smtp-pane";

// Old pane name -> new route (aliases from the old hash router included:
// security→account, jellyfin→apikey, email→smtp). pane=smtp/email stays here.
const REDIRECTS: Record<string, string> = {
  account: "/account/",
  security: "/account/",
  credentials: "/account/?section=credentials",
  defaults: "/account/?section=defaults",
  apikey: "/account/?section=apikey",
  jellyfin: "/account/?section=apikey",
  appearance: "/appearance/",
  users: "/users/",
};

function SettingsRedirector() {
  const params = useSearchParams();
  const router = useRouter();
  const target = REDIRECTS[params.get("pane") ?? ""];

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (target) return <div className="view active" />; // redirecting — no flash

  return <SettingsBody />;
}

function SettingsBody() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  return (
    <SettingsRouteShell
      title="Settings"
      description="App-wide configuration for this server — owner only."
    >
      {isOwner ? <SmtpPane /> : <NotAuthorized needs="the owner" />}
    </SettingsRouteShell>
  );
}

export default function SettingsPage() {
  return (
    <AppShell>
      <Suspense fallback={<div className="view active" />}>
        <SettingsRedirector />
      </Suspense>
    </AppShell>
  );
}
