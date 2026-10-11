"use client";

// Card size — Shiori's library card sizes (RenzoFrontend app/library/page.tsx
// cardWidthOptions), shared by every Renzo cover grid and row. One choice,
// made on the Library ribbon, governs them all (Shiori: Library + Browse).
// Per-browser convenience, kept in localStorage; unset falls back per screen
// as Shiori's does (S on a phone, M otherwise).

import { useEffect, useState } from "react";

export interface CardSize {
  value: string;
  label: string;
  /** Cover width in px — the grid's minimum column / a row's card width. */
  px: number;
  /** Title-bar text class. */
  text: string;
  /** Corner-badge text class. */
  badge: string;
}

export const CARD_SIZES: CardSize[] = [
  { value: "w-20", label: "XS", px: 80, text: "text-[0.4rem]", badge: "text-[0.4rem]" },
  { value: "w-32", label: "S", px: 128, text: "text-xs", badge: "text-xs" },
  { value: "w-45", label: "M", px: 180, text: "text-sm", badge: "text-xs" },
  { value: "w-58", label: "L", px: 232, text: "text-base", badge: "text-sm" },
  { value: "w-70", label: "XL", px: 280, text: "text-lg", badge: "text-base" },
];

const KEY = "renzo-card-width";
const EVENT = "renzo-card-width";

function defaultValue(): string {
  if (typeof window === "undefined") return "w-45";
  return window.matchMedia("(max-width: 639px)").matches ? "w-32" : "w-45";
}

function read(): string {
  try {
    return localStorage.getItem(KEY) || defaultValue();
  } catch {
    return defaultValue();
  }
}

export function setCardSize(value: string): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* private mode — the choice just doesn't persist */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** The card size in force, live across every grid on the page. */
export function useCardSize(): CardSize {
  const [value, setValue] = useState("w-45");
  useEffect(() => {
    setValue(read());
    const on = () => setValue(read());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  return CARD_SIZES.find((s) => s.value === value) ?? CARD_SIZES[2]!;
}
