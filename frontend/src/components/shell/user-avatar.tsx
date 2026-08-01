"use client";

// Shared avatar circle — Shiori's base64-avatar model (the user record carries
// avatarBase64/avatarContentType; GET /api/auth/me and GET /api/users include
// them). With an image set it renders a data-URL <img> (rounded-full,
// object-cover); without one it falls back to the initials treatment the shell
// has used since the first port (border-primary/30 bg-primary/20 text-primary).
//
// `bare` is for containers that ARE the circle already — the #acctBtn topbar
// button keeps its literal `avatar avatar-btn` classes, size and colors per
// CONTRACTS.md, so there the image just fills the button and initials render
// as plain text that inherits the button's own styling.

import React from "react";

import { cn } from "@/lib/utils";

/** The subset of PublicUser an avatar needs (users-list rows qualify too). */
export interface AvatarLike {
  username?: string | null;
  avatarBase64?: string | null;
  avatarContentType?: string | null;
}

/** Shiori shows two initials on menu circles; list rows show one (old
 *  `initial()` in settings/shared — keep its "·" placeholder for that case). */
export function avatarInitials(name?: string | null, chars = 1): string {
  const n = (name || "").trim();
  if (!n) return chars > 1 ? "?" : "·";
  return n.slice(0, chars).toUpperCase();
}

export function UserAvatar({
  user,
  className,
  chars = 1,
  bare = false,
  alt,
}: {
  user?: AvatarLike | null;
  /** Size + typography, e.g. "h-9 w-9 text-sm" (ignored for bare initials). */
  className?: string;
  /** Initials length when no image: 2 on menu circles, 1 on list rows. */
  chars?: number;
  /** Parent already provides the circle (topbar #acctBtn) — see file header. */
  bare?: boolean;
  alt?: string;
}) {
  const b64 = user?.avatarBase64 || null;
  if (b64) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data URL, no optimizer
      <img
        src={`data:${user?.avatarContentType || "image/png"};base64,${b64}`}
        alt={alt ?? (user?.username ? `${user.username}'s avatar` : "Avatar")}
        draggable={false}
        className={cn(
          "shrink-0 rounded-full object-cover",
          bare && "h-full w-full",
          className,
        )}
      />
    );
  }
  const txt = avatarInitials(user?.username, chars);
  if (bare) return <>{txt}</>;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 select-none place-items-center rounded-full border border-primary/30 bg-primary/20 font-semibold text-primary",
        className,
      )}
    >
      {txt}
    </span>
  );
}
