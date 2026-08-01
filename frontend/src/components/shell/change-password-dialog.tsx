"use client";

// Self-service password change — Shiori's ChangePasswordDialog pattern
// (comp/users/change-password-dialog.tsx) against Renzo's endpoint:
//   POST /api/account/password  { currentPassword, newPassword }
// (src/routes/auth.ts accountRoutes) → { ok: true }. The server re-verifies
// the current password (403 "Current password is incorrect"), enforces the
// 8–128 char shape, revokes every OTHER session and reissues this one's
// cookie — so the caller stays signed in, no auth-gate bounce.
//
// Real <input type="password"> with autocomplete hints on purpose: this is a
// genuine account password, where manager integration is wanted. The
// suppressAutofill masking from CONTRACTS.md is for credential tokens only.

import React, { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveModal } from "@/components/ui/responsive-modal";
import { api } from "@/lib/api";

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Mirror the server's validCredentialShape floor so the common mistakes
    // never round-trip (services/auth.ts:43 — 8..128 chars).
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setPending(true);
    try {
      await api("/account/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      toast.success("Password changed");
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPending(false);
    }
  };

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={handleOpenChange}
      title="Change password"
      description="Enter your current password, then choose a new one."
      desktopMaxWidth="max-w-sm"
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-1">
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="currentPassword">Current password</Label>
          <Input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newPassword">New password</Label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmNewPassword">Confirm new password</Label>
          <Input
            id="confirmNewPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Changing…" : "Change password"}
        </Button>
      </form>
    </ResponsiveModal>
  );
}
