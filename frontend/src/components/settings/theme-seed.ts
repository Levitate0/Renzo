"use client";

// Seed the local theme once from the server-side user.theme when this device
// has no saved preset yet (fresh browser / cleared storage). setPreset writes
// `renzo-preset`, so the seed can never run twice. Lived in the old
// settings-view (single /settings/ page); now every settings-family route
// calls it via SettingsRouteShell.

import { useEffect, useRef } from "react";

import { useAuth } from "@/contexts/auth-context";
import { hexToHslStr, setCustomAccent, setPreset } from "@/lib/utils/theme-preset";

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

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
