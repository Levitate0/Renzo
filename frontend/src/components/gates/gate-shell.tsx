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
    <div
      className={cn(
        "auth-gate fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto",
        "bg-background/95 backdrop-blur-sm px-4 py-[8dvh]",
        className,
      )}
    >
      <div
        className={cn(
          "auth-card flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-6 shadow-xl",
          wide ? "max-w-md" : "max-w-sm",
        )}
      >
        {children}
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
      className="auth-banner mx-auto mb-1 w-48 max-w-[70%]"
    />
  );
}

export function GateError({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-error min-h-4 text-sm text-destructive" role="alert">
      {children}
    </div>
  );
}
