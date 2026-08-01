"use client";

// Shared bits for the settings panes — the pill-state chips, role badges and
// small layout helpers that the old app drove with .pill-state / .role-badge /
// .field classes (public/index.html settings modal + app.js setPill/roleLabel).

import { Medal } from "lucide-react";
import React from "react";
import { toast } from "sonner";

import type { DebridHealth, Role } from "@/lib/types";
import { cn } from "@/lib/utils";

// --- pill states (old setPill: "pill-state ok|warn|err") --------------------

export type PillState = "ok" | "warn" | "err" | "muted";

const PILL_CLS: Record<PillState, string> = {
  ok: "bg-emerald-500/15 text-emerald-400",
  warn: "bg-amber-500/15 text-amber-400",
  err: "bg-red-500/15 text-red-400",
  muted: "bg-muted text-muted-foreground",
};

export function Pill({ state, children }: { state: PillState; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
        PILL_CLS[state],
      )}
    >
      {children}
    </span>
  );
}

/** Old RD_MAP (app.js:2373) — health value -> [pill state, label]. */
export const RD_PILL: Record<DebridHealth, [PillState, string]> = {
  premium: ["ok", "Premium"],
  "not-premium": ["warn", "Connected · not premium"],
  connected: ["ok", "Connected"],
  "not-connected": ["err", "Not connected"],
  invalid: ["err", "Invalid token"],
};

export function debridPill(v: DebridHealth | undefined): [PillState, string] {
  if (!v) return ["muted", "checking…"];
  return RD_PILL[v] ?? ["err", "Not connected"];
}

// --- role helpers (old roleLabel / role-badge / initial) --------------------

export const roleLabel = (r: Role | string): string =>
  r === "owner" ? "Owner" : r === "manager" ? "Manager" : "User";

export const initial = (name?: string | null): string =>
  (name || "·").trim().charAt(0).toUpperCase() || "·";

export function RoleBadge({ role }: { role: Role | string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4",
        role === "owner"
          ? "bg-primary/15 text-primary"
          : role === "manager"
            ? "bg-sky-500/15 text-sky-400"
            : "bg-muted text-muted-foreground",
      )}
    >
      {/* Medal icon = Shiori's level pill (user-manager.tsx levelColors row). */}
      <Medal className="mr-1 h-3 w-3" />
      {roleLabel(role)}
    </span>
  );
}

// --- layout helpers ---------------------------------------------------------

/** One labeled form field (old `.field` + `.hint`). */
export function Field({
  label,
  htmlFor,
  pill,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  pill?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground"
      >
        {label}
        {pill}
      </label>
      {children}
      {hint ? <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** Section wrapper — a Shiori-style card with title + description. */
export function PaneSection({
  title,
  sub,
  actions,
  children,
}: {
  title?: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      {(title || actions) && (
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
            {sub ? <p className="mt-1 text-sm text-muted-foreground">{sub}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      )}
      {!title && sub ? <p className="mb-3 text-sm text-muted-foreground">{sub}</p> : null}
      <div className="grid grid-cols-1 gap-4">{children}</div>
    </section>
  );
}

/** Connection row (old `.conn-row`): icon · name/desc · pill · optional action. */
export function ConnRow({
  icon,
  name,
  desc,
  pill,
  action,
}: {
  icon: React.ReactNode;
  name: string;
  desc: React.ReactNode;
  pill: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="truncate text-xs text-muted-foreground">{desc}</div>
      </div>
      {pill}
      {action}
    </div>
  );
}

// --- misc -------------------------------------------------------------------

/** Clipboard with toast (old copyText, app.js:2591). */
export function copyText(text: string | undefined | null, okMsg: string): void {
  if (!text) {
    toast("Nothing to copy");
    return;
  }
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast(okMsg))
    .catch(() => toast("Copy failed"));
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
