"use client";

// Profile-avatar editing — Shiori's EditUserDialog avatar UX (Rensaio
// comp/users/user-dialog.tsx: preview + file upload + gravatar-by-email)
// against Renzo's self-service endpoints (src/routes/auth.ts accountRoutes):
//   POST /api/account/avatar          {avatarBase64, contentType} saves,
//                                     {avatarBase64: null} clears
//   POST /api/account/avatar/gravatar {email} → preview payload (404 if none;
//                                     stored only when the user hits Save)
//
// Files are resized CLIENT-side: the picked image is center-cropped square and
// drawn onto a 128×128 canvas, exported as image/webp q0.85 — browsers that
// can't encode webp (Safari/Firefox toDataURL) hand back a png and we send
// that instead. Either way the upload sits far under the server's 256KB
// decoded cap, and the data: prefix is stripped before POSTing.
//
// Two exports for the same reason change-password has two homes:
//   * AvatarDialog — ResponsiveModal from the account menu (pointer platforms
//     only; follows change-password-dialog's pattern).
//   * AvatarEditor — the SAME controls inline (no portal) in /account/'s
//     account section, because Radix portals land outside every tvnav root and
//     the TV D-pad could never reach a dialog's controls (see the gate note in
//     account-menu.tsx).

import { Trash2, Upload } from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { UserAvatar } from "@/components/shell/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveModal } from "@/components/ui/responsive-modal";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import type { AvatarSaveResponse, GravatarPreview } from "@/lib/types";

const AVATAR_SIDE = 128;

interface PendingAvatar {
  base64: string;
  contentType: string;
}

/** Center-crop square → 128×128 canvas → webp q0.85 (png fallback) → base64. */
async function fileToAvatar(file: File): Promise<PendingAvatar> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = document.createElement("img");
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Couldn't read that image"));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error("Couldn't read that image");
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image resizing is unavailable in this browser");
    ctx.drawImage(
      img,
      (img.naturalWidth - side) / 2,
      (img.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIDE,
      AVATAR_SIDE,
    );
    let dataUrl = canvas.toDataURL("image/webp", 0.85);
    let contentType = "image/webp";
    if (!dataUrl.startsWith("data:image/webp")) {
      // Browser can't encode webp — toDataURL silently fell back to png.
      dataUrl = canvas.toDataURL("image/png");
      contentType = "image/png";
    }
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), contentType };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The avatar controls themselves: current/pending preview (96px circle,
 * initials fallback), file picker, Gravatar-by-email fetch, Remove (only when
 * an avatar exists — clears immediately), Save (applies the pending pick).
 */
export function AvatarEditor({ onSaved }: { onSaved?: () => void }) {
  const { user, updateUser } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const gravatarId = useId();

  const [pending, setPending] = useState<PendingAvatar | null>(null);
  const [gravatarEmail, setGravatarEmail] = useState(user?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Prefill the Gravatar email once the user record arrives (same pattern as
  // account-pane's email field) — without clobbering anything already typed.
  useEffect(() => {
    setGravatarEmail((cur) => cur || (user?.email ?? ""));
  }, [user?.email]);

  const hasAvatar = !!user?.avatarBase64;
  const previewSrc = pending
    ? `data:${pending.contentType};base64,${pending.base64}`
    : null;

  const fail = (e: unknown, fallback: string) => {
    const msg = e instanceof Error && e.message ? e.message : fallback;
    setError(msg);
    toast(msg);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked
    if (!file) return;
    setError("");
    try {
      setPending(await fileToAvatar(file));
    } catch (err) {
      fail(err, "Couldn't read that image");
    }
  };

  const fetchGravatar = async () => {
    const email = gravatarEmail.trim();
    if (!email) {
      fail(null, "Enter an email address to look up");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<GravatarPreview>("/account/avatar/gravatar", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setPending({ base64: r.avatarBase64, contentType: r.avatarContentType });
    } catch (err) {
      fail(err, "Gravatar lookup failed");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<AvatarSaveResponse>("/account/avatar", {
        method: "POST",
        body: JSON.stringify({
          avatarBase64: pending.base64,
          contentType: pending.contentType,
        }),
      });
      // Patch the cached auth user — topbar/menu/pane circles update at once.
      updateUser({ avatarBase64: r.avatarBase64, avatarContentType: r.avatarContentType });
      setPending(null);
      toast("Avatar updated");
      onSaved?.();
    } catch (err) {
      fail(err, "Couldn't save avatar");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api<AvatarSaveResponse>("/account/avatar", {
        method: "POST",
        body: JSON.stringify({ avatarBase64: null }),
      });
      updateUser({ avatarBase64: null, avatarContentType: null });
      setPending(null);
      toast("Avatar removed");
    } catch (err) {
      fail(err, "Couldn't remove avatar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        {/* 96px preview: pending pick beats the saved avatar beats initials. */}
        {previewSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URL preview
          <img
            src={previewSrc}
            alt="New avatar preview"
            draggable={false}
            className="h-24 w-24 shrink-0 rounded-full object-cover"
          />
        ) : (
          <UserAvatar user={user} chars={2} className="h-24 w-24 text-2xl" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" /> Upload image
            </Button>
            {hasAvatar && (
              <Button
                type="button"
                variant="ghost"
                className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                disabled={busy}
                onClick={() => void remove()}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Remove
              </Button>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Any image works — it&apos;s center-cropped and resized to 128×128 in your browser
            before upload.
          </p>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void onFile(e)}
      />

      <div className="grid grid-cols-1 gap-1.5">
        <Label htmlFor={gravatarId}>Use Gravatar</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={gravatarId}
            type="email"
            inputMode="email"
            placeholder="you@example.com"
            className="w-full flex-1 sm:w-auto"
            value={gravatarEmail}
            onChange={(e) => setGravatarEmail(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            disabled={busy}
            onClick={() => void fetchGravatar()}
          >
            Fetch
          </Button>
        </div>
        <span className="text-xs leading-relaxed text-muted-foreground">
          Looks up that address&apos;s Gravatar (via the server) as a preview — nothing changes
          until you save.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={!pending || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save avatar"}
        </Button>
        {pending && (
          <span className="text-xs text-muted-foreground">New image ready — save to apply.</span>
        )}
      </div>
    </div>
  );
}

/** Account-menu dialog wrapper — change-password-dialog's ResponsiveModal
 *  pattern. Radix unmounts the content on close, so the editor's pending
 *  state resets each time it opens (same reset semantics as the pw dialog). */
export function AvatarDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ResponsiveModal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit avatar"
      description="Shown on the account menu and the users list."
      desktopMaxWidth="max-w-sm"
    >
      <div className="py-1">
        <AvatarEditor onSaved={() => onOpenChange(false)} />
      </div>
    </ResponsiveModal>
  );
}
