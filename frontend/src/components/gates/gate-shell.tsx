"use client";

// Shared full-screen auth-gate overlay + card. The literal `auth-gate` class is
// a tvnav.js contract: a visible .auth-gate is a BLOCKING root, so D-pad focus
// stays inside the gate. The banner is Renzo's byte-preserved wordmark.

import React from "react";

import { cn } from "@/lib/utils";

export function GateShell({
  children,
  wide = false,
  className,
}: {
  children: React.ReactNode;
  /** Setup/invite cards are a little wider (old .setup-card). */
  wide?: boolean;
  className?: string;
}) {
  return (
    // Centred on both axes. The scroll lives on the OUTER fixed layer and the
    // centring on an inner min-h-full flex row: centring directly on a
    // scroll container puts the overflow above the scroll origin, so a card
    // taller than the viewport (setup/invite on a phone) loses its top edge
    // with no way to reach it.
    <div
      className={cn(
        "auth-gate fixed inset-0 z-[100] overflow-y-auto",
        "bg-background/95 backdrop-blur-sm",
        className,
      )}
    >
      <div className="flex min-h-full items-center justify-center px-4 py-8">
        <div
          className={cn(
            "auth-card flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-6 shadow-xl",
            wide ? "max-w-md" : "max-w-sm",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function GateBanner() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/renzo-banner.png"
      alt="Renzo"
      // Renzo's banner, left at its own size deliberately — the layout around
      // it follows Shiori's login, the wordmark does not.
      className="auth-banner mx-auto mb-1 w-48 max-w-[70%]"
    />
  );
}

/** Shiori's login error block: a red-washed panel, not a bare line of red text.
 *  Renders nothing when empty — the old min-h-4 reserved a gap for a message
 *  that usually isn't there, and a padded box can't be reserved invisibly. */
export function GateError({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="auth-error rounded-md bg-red-950 p-3 text-sm text-red-500" role="alert">
      {children}
    </div>
  );
}
