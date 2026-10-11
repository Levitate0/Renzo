"use client";

// Account pane (default) — laid out as Shiori's Account section (Profile
// picture / Security cards) plus Renzo's connection overview; merges the old
// "Account" pane with the old "Security" pane (email for password
// resets + password change). Old sources: index.html panes account/security,
// app.js showSettingsPage / emailSave / passSave.
//
// Password change note: the backend (/api/account/password) revokes every
// OTHER session and reissues this one's cookie — that IS the old
// "signs out all your other sessions" behavior; no extra endpoint exists.

import { BookMarked, BookOpen, Check, Link2, Lock, Mail } from "lucide-react";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import { AvatarEditor } from "@/components/shell/avatar-dialog";
import { useHealthQuery } from "@/components/shell/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { useAutofillGuard, useMaskedInput } from "@/lib/autofill";
import type { PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";

import { ConnRow, debridPill, errMsg, Pill, RoleBadge } from "@/components/settings/shared";

export function AccountPane() {
  const { user, updateUser } = useAuth();
  const { data: health } = useHealthQuery();

  const [email, setEmail] = useState(user?.email ?? "");
  const [curPass, setCurPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const emailGuard = useAutofillGuard();
  const curMask = useMaskedInput();
  const newMask = useMaskedInput();

  // Populate the email field once the user record arrives (old #acctEmail).
  useEffect(() => {
    setEmail(user?.email ?? "");
  }, [user?.email]);

  const saveEmail = async () => {
    try {
      const u = await api<PublicUser>("/account/email", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      updateUser({ email: u.email });
      toast(u.email ? "Email saved" : "Email cleared");
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const [confirmPass, setConfirmPass] = useState("");
  const [passError, setPassError] = useState("");
  const confirmMask = useMaskedInput();

  const savePassword = async () => {
    setPassError("");
    // Shiori's client checks (account/page.tsx) before the round-trip.
    if (newPass.length < 8) return setPassError("New password must be at least 8 characters");
    if (newPass !== confirmPass) return setPassError("Passwords do not match");
    try {
      await api("/account/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: curPass, newPassword: newPass }),
      });
      setCurPass("");
      setNewPass("");
      setConfirmPass("");
      toast("Password changed");
    } catch (e) {
      setPassError(errMsg(e));
    }
  };

  // /health names the provider in use in `.debrid`; reading only realdebrid
  // showed an AllDebrid-only account as "Not connected" (the Hub fixed this
  // already — same fix here).
  const debridIsAd = health?.debrid === "alldebrid";
  const [rdState, rdLabel] = debridPill(debridIsAd ? health?.alldebrid : health?.realdebrid);
  const ani = !!health?.trackers.anilist;
  const mal = !!health?.trackers.mal;

  // Shiori's Account section, card for card: Profile picture, Security, then
  // Renzo's Connections.
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle>Profile picture</CardTitle>
          <CardDescription>Shown on the account menu and the users list.</CardDescription>
        </CardHeader>
        {/* The SAME controls as the account menu's "Edit avatar…" dialog, but
            inline (no portal): Radix dialogs land outside every tvnav root, so
            this is the only D-pad-reachable home for avatar editing on TV. */}
        <CardContent className="space-y-3">
          <AvatarEditor />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle>Security</CardTitle>
          <CardDescription>Changing your password signs out all your other sessions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="acctEmail" className="flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              Email
            </Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="acctEmail"
                type="email"
                inputMode="email"
                {...emailGuard}
                className="w-full flex-1 sm:w-auto"
                placeholder="Optional — used for password reset"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button className="shrink-0" disabled={email.trim() === (user?.email ?? "")} onClick={() => void saveEmail()}>
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Password-reset links are sent here. Leave empty to disable email reset for this account.
            </p>
          </div>

          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Lock className="h-3.5 w-3.5" />
              Password
            </div>
            {passError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-500 dark:bg-red-950">{passError}</div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="curPass">Current password</Label>
                <Input
                  id="curPass"
                  {...curMask}
                  className={cn(curMask.className)}
                  value={curPass}
                  onChange={(e) => setCurPass(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPass">New password</Label>
                <Input
                  id="newPass"
                  {...newMask}
                  className={cn(newMask.className)}
                  placeholder="At least 8 characters"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2 sm:w-1/2 sm:pr-1.5">
              <Label htmlFor="confirmPass">Confirm new password</Label>
              <Input
                id="confirmPass"
                {...confirmMask}
                className={cn(confirmMask.className)}
                value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)}
              />
            </div>
            <Button onClick={() => void savePassword()}>
              <Check className="mr-2 h-4 w-4" />
              Update password
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex flex-wrap items-center gap-2">
            Connections
            {user ? <RoleBadge role={user.role} /> : null}
          </CardTitle>
          <CardDescription>
            Your debrid service streams and downloads; AniList and MyAnimeList import lists and
            track what you watch. Set them up under Required credentials.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2">
          <ConnRow
            icon={<Link2 className="h-4 w-4" />}
            name={debridIsAd ? "AllDebrid" : "Real-Debrid"}
            desc="Required to stream & download"
            pill={<Pill state={rdState}>{rdLabel}</Pill>}
          />
          <ConnRow
            icon={<BookOpen className="h-4 w-4" />}
            name="AniList"
            desc="List import & scrobbling"
            pill={
              <Pill state={health ? (ani ? "ok" : "warn") : "muted"}>
                {health ? (ani ? "Connected" : "Not connected") : "checking…"}
              </Pill>
            }
          />
          <ConnRow
            icon={<BookMarked className="h-4 w-4" />}
            name="MyAnimeList"
            desc="List import & scrobbling"
            pill={
              <Pill state={health ? (mal ? "ok" : "warn") : "muted"}>
                {health ? (mal ? "Connected" : "Not connected") : "checking…"}
              </Pill>
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
