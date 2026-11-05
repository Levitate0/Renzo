import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * An episode's air date ("YYYY-MM-DD", the Japanese broadcast date from MAL /
 * AniList) for the episode lists: "Sep 29, 2023", or "Airs Oct 13" while it
 * hasn't aired. Built from its parts, never `new Date("YYYY-MM-DD")`, which is
 * UTC midnight and shows the day before anywhere west of Greenwich.
 * Hub twin: feature-renzo AirDate.kt airDateLabel.
 */
export function airDateLabel(day: string | null | undefined, unaired = false): string | null {
  const m = day?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (unaired) {
    return `Airs ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
