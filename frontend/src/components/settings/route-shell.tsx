"use client";

// Shared chrome for the settings-family routes — /account/, /appearance/,
// /users/ and /settings/ (Shiori's Account-vs-Settings IA split).
//
// TV Back contract: these are real pages now, not the old settings modal, but
// tvnav's RenzoTV.back() only consumes a Back press when it finds
// `.modal:not(.hidden)` (public/tvnav.js:136) — otherwise it returns false and
// Android EXITS the app. So every settings route root still carries the
// literal `modal` marker class (no styles attached; purely a tvnav signal),
// and this shell owns the Escape → close step that tvnav's Back dispatches.
// Side effect (same as the old settings modal, so no regression): while one of
// these pages is open, tvnav treats it as the blocking root and scopes D-pad
// focus inside the page — the topbar/tabs are reached by pressing Back out.

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect } from "react";

import { useThemeSeed } from "@/components/settings/theme-seed";
import { Button } from "@/components/ui/button";

export function SettingsRouteShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  const router = useRouter();
  useThemeSeed(); // seed local theme from server user.theme on a fresh device

  // Leave the page — old closeModal cleared the hash, returning to the
  // previous tab (public/app.js:1906).
  const close = useCallback(() => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  }, [router]);

  // Escape closes the page — unless another layer (sheet / dialog / select /
  // popover / auth gate) owns the press. This is what makes TV Back work: see
  // the `modal` marker note above.
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

  return (
    // `view active` = tvnav page root (CONTRACTS); `modal` = TV Back marker.
    <div className="view active modal mx-auto w-full max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {/* Old modal's ✕ close (public/index.html:273). */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={close}
          className="shrink-0"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>
      {children}
    </div>
  );
}
