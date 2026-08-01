"use client";
import * as React from "react";

/**
 * Named theme presets — each bundles a full background palette (via
 * `[data-theme]` on <html>, see globals.css) plus a default accent. The app
 * is dark-only (no light mode, see layout.tsx) — a custom accent can
 * override any preset's highlight color (inline --primary-h/s/l), independent
 * of the palette. "renzo" (the base palette) needs no [data-theme] block —
 * the defaults already are it.
 */
export interface ThemePreset {
  id: string;
  label: string;
  /** Preview swatches. */
  bg: string;
  card: string;
  accent: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: "renzo", label: "Renzo", bg: "hsl(20 14.3% 4.1%)", card: "hsl(24 9.8% 10%)", accent: "hsl(346.8 77.2% 49.8%)" },
  { id: "amoled", label: "AMOLED", bg: "hsl(0 0% 0%)", card: "hsl(0 0% 7%)", accent: "hsl(346.8 77.2% 49.8%)" },
  { id: "midnight", label: "Midnight", bg: "hsl(222 47% 8%)", card: "hsl(222 40% 13%)", accent: "hsl(217.2 91.2% 59.8%)" },
  { id: "sakura", label: "Sakura", bg: "hsl(330 22% 7%)", card: "hsl(330 18% 12%)", accent: "hsl(340 82% 66%)" },
  { id: "matcha", label: "Matcha", bg: "hsl(140 15% 6%)", card: "hsl(140 12% 11%)", accent: "hsl(142.1 70.6% 45.3%)" },
  { id: "ember", label: "Ember", bg: "hsl(20 22% 6%)", card: "hsl(20 18% 11%)", accent: "hsl(24.6 95% 53.1%)" },
  { id: "ocean", label: "Ocean", bg: "hsl(195 40% 7%)", card: "hsl(195 34% 12%)", accent: "hsl(172 66% 45%)" },
];

const PRESET_KEY = "renzo-preset";
const ACCENT_KEY = "renzo-accent"; // "custom" = override; anything else = use preset accent
const CUSTOM_KEY = "renzo-accent-custom"; // "H S% L%"
const CHANGE_EVENT = "renzo-theme-changed";
const DEFAULT_PRESET = "renzo";
const DEFAULT_CUSTOM = "265 83% 58%";
const BASE_PRESETS = new Set(["renzo"]);

export function presetById(id: string): ThemePreset {
  return THEME_PRESETS.find((t) => t.id === id) ?? (THEME_PRESETS[0] as ThemePreset);
}

export function getPreset(): string {
  if (typeof window === "undefined") return DEFAULT_PRESET;
  const p = localStorage.getItem(PRESET_KEY);
  return THEME_PRESETS.some((t) => t.id === p) ? (p as string) : DEFAULT_PRESET;
}
export function isCustomAccent(): boolean {
  return typeof window !== "undefined" && localStorage.getItem(ACCENT_KEY) === "custom";
}
export function getCustomHsl(): string {
  if (typeof window === "undefined") return DEFAULT_CUSTOM;
  return localStorage.getItem(CUSTOM_KEY) || DEFAULT_CUSTOM;
}

/** Apply palette (data-theme) + accent (inline custom or the preset's) to <html>. */
export function applyThemeDom(preset: string, customOn: boolean, customHsl: string): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  if (BASE_PRESETS.has(preset)) el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", preset);

  if (customOn) {
    const [ph, ps, pl] = customHsl.trim().split(/\s+/);
    if (ph !== undefined && ps !== undefined && pl !== undefined) {
      el.style.setProperty("--primary-h", ph);
      el.style.setProperty("--primary-s", ps);
      el.style.setProperty("--primary-l", pl);
    }
    el.setAttribute("data-accent", "custom");
  } else {
    el.style.removeProperty("--primary-h");
    el.style.removeProperty("--primary-s");
    el.style.removeProperty("--primary-l");
    el.removeAttribute("data-accent");
  }
}

function emit() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Select a theme preset (palette). The app is always dark. */
export function setPreset(id: string): void {
  if (typeof window === "undefined") return;
  // Falls back to the default for an unrecognized id — covers a stale/legacy
  // value (e.g. the removed light "daylight" preset) instead of applying a
  // dead [data-theme] attribute that matches no CSS block.
  const resolved = THEME_PRESETS.some((t) => t.id === id) ? id : DEFAULT_PRESET;
  localStorage.setItem(PRESET_KEY, resolved);
  applyThemeDom(resolved, isCustomAccent(), getCustomHsl());
  emit();
}
export function setCustomAccent(hsl: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACCENT_KEY, "custom");
  localStorage.setItem(CUSTOM_KEY, hsl);
  applyThemeDom(getPreset(), true, hsl);
  emit();
}
/** Drop the custom accent override; the selected theme's accent applies. */
export function clearCustomAccent(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACCENT_KEY, "preset");
  applyThemeDom(getPreset(), false, getCustomHsl());
  emit();
}

interface ThemeState {
  preset: string;
  customOn: boolean;
  customHsl: string;
}

function snapshot(): string {
  return `${getPreset()}|${isCustomAccent() ? "1" : "0"}|${getCustomHsl()}`;
}
function subscribe(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useTheme(): ThemeState {
  const snap = React.useSyncExternalStore(subscribe, snapshot, () => `${DEFAULT_PRESET}|0|${DEFAULT_CUSTOM}`);
  return React.useMemo(() => {
    const [preset, custom, hsl] = snap.split("|");
    return {
      preset: preset ?? DEFAULT_PRESET,
      customOn: custom === "1",
      customHsl: hsl ?? DEFAULT_CUSTOM,
    };
  }, [snap]);
}

// hex <-> "H S% L%" helpers for the color input.
export function hslStrToHex(hsl: string): string {
  const [h = "0", s = "0%", l = "0%"] = hsl.trim().split(/\s+/);
  const H = parseFloat(h) / 360;
  const S = parseFloat(s) / 100;
  const L = parseFloat(l) / 100;
  const k = (n: number) => (n + H * 12) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
export function hexToHslStr(hex: string): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.substring(0, 2), 16) / 255;
  const g = parseInt(m.substring(2, 4), 16) / 255;
  const b = parseInt(m.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}
