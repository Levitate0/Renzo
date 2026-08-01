"use client";

// TV-safe select. Radix Select's listbox opens in a portal OUTSIDE tvnav.js's
// roots() (`.view.active` + chrome), so tvnav's capture-phase arrow handler
// doesn't recognise it: move() yanks focus to the first page element and
// Radix's dismissable layer closes the popup on the very first D-pad press.
// tvnav DOES special-case native selects (its `inSelect` branches leave
// ArrowUp/Down to change options and Enter alone, and `select:not([disabled])`
// is in its FOCUSABLE list) — exactly how the old app's settings selects
// worked on TV. So: shadcn Radix Select everywhere, a styled native <select>
// when TV mode is on. See CONTRACTS.md "DOM contract for tvnav.js".

import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsTv } from "@/lib/tv";
import { cn } from "@/lib/utils";

export interface TvSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function TvSelect({
  value,
  onValueChange,
  options,
  className,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: TvSelectOption[];
  /** Applied to the Radix trigger / the native select (widths, heights…). */
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const tv = useIsTv();

  if (tv) {
    return (
      <select
        className={cn(
          // Mirror SelectTrigger's look; keep the UA dropdown arrow (native
          // pickers on TV render system-side anyway). Option colors follow
          // the old `.folder-pick select option` rule so the popup list is
          // readable on the dark theme.
          "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>option]:bg-popover [&>option]:text-popover-foreground",
          className
        )}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
