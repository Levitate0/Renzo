"use client";

// Appearance pane — dark-only theme presets + custom accent, Shiori's scheme
// (src/lib/utils/theme-preset.ts, localStorage renzo-preset / renzo-accent /
// renzo-accent-custom). Replaces the old #view-appearance tab (app.js 457-515).
// The old light "Daylight" preset is intentionally gone — no light mode.
//
// Server sync: like the old persistTheme(), every change is also POSTed to
// /api/account/theme (preset + accent hex) so a fresh device can seed from the
// account; `useThemeSeed` applies user.theme ONCE when localStorage is empty.

import React, { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import {
  clearCustomAccent,
  hexToHslStr,
  hslStrToHex,
  presetById,
  setCustomAccent,
  setPreset,
  THEME_PRESETS,
  useTheme,
} from "@/lib/utils/theme-preset";
import { cn } from "@/lib/utils";

import { PaneSection } from "../shared";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Persist the current appearance to the account (fire-and-forget). */
function persistTheme(preset: string, accentHex?: string): void {
  void api("/account/theme", {
    method: "POST",
    body: JSON.stringify({ preset, ...(accentHex ? { accent: accentHex } : {}) }),
  }).catch(() => {});
}

/**
 * Seed the local theme once from the server-side user.theme when this device
 * has no saved preset yet (fresh browser / cleared storage). setPreset writes
 * `renzo-preset`, so the seed can never run twice.
 */
export function useThemeSeed(): void {
  const { user } = useAuth();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !user?.theme || typeof window === "undefined") return;
    if (localStorage.getItem("renzo-preset")) return;
    done.current = true;
    setPreset(user.theme.preset);
    if (user.theme.accent && HEX_RE.test(user.theme.accent)) {
      setCustomAccent(hexToHslStr(user.theme.accent));
    }
  }, [user]);
}

export function AppearancePane() {
  const { preset, customOn, customHsl } = useTheme();

  const pickPreset = (id: string) => {
    setPreset(id);
    persistTheme(id, customOn ? hslStrToHex(customHsl) : undefined);
  };

  const pickAccent = (hex: string) => {
    if (!HEX_RE.test(hex)) return;
    setCustomAccent(hexToHslStr(hex));
    persistTheme(preset, hex);
  };

  const usePresetAccent = () => {
    clearCustomAccent();
    persistTheme(preset);
  };

  const accentHex = customOn ? hslStrToHex(customHsl) : hexOf(presetById(preset).accent);

  return (
    <div className="grid grid-cols-1 gap-4">
      <PaneSection
        title="Theme"
        sub="Pick a palette for this account. Renzo is dark-only — presets restyle the dark scheme."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {THEME_PRESETS.map((t) => {
            const active = t.id === preset;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => pickPreset(t.id)}
                aria-pressed={active}
                className={cn(
                  "group overflow-hidden rounded-xl border text-left transition",
                  active
                    ? "border-primary ring-2 ring-primary/40"
                    : "border-border hover:border-muted-foreground/40",
                )}
              >
                <div
                  className="relative h-16 w-full p-2"
                  style={{ background: t.bg }}
                  aria-hidden
                >
                  <span
                    className="absolute inset-x-2 bottom-2 top-4 rounded-md"
                    style={{ background: t.card }}
                  />
                  <span
                    className="absolute left-3.5 top-5.5 h-2.5 w-2.5 rounded-full"
                    style={{ background: t.accent }}
                  />
                </div>
                <div className="flex items-center justify-between px-2.5 py-1.5 text-xs font-medium">
                  {t.label}
                  {active ? <span className="text-primary">●</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </PaneSection>

      <PaneSection
        title="Accent"
        sub="Override the preset's highlight color — applies on top of any theme."
      >
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="color"
            aria-label="Custom accent color"
            className="h-9 w-14 cursor-pointer rounded-md border border-border bg-transparent p-1"
            value={accentHex}
            onChange={(e) => pickAccent(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">
            {customOn ? "Custom accent active" : "Using the preset accent"}
          </span>
          {customOn && (
            <Button variant="outline" size="sm" onClick={usePresetAccent}>
              Use preset accent
            </Button>
          )}
        </div>
      </PaneSection>
    </div>
  );
}

/** Preset accents are "hsl(H S% L%)" strings — normalize for <input type=color>. */
function hexOf(accent: string): string {
  const m = /^hsl\((.+)\)$/.exec(accent.trim());
  if (m?.[1]) return hslStrToHex(m[1]);
  return HEX_RE.test(accent) ? accent : "#e11d48";
}
