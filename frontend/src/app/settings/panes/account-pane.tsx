"use client";

// Account pane (default) — profile header + connection overview (old
// "Account" pane) merged with the old "Security" pane (email for password
// resets + password change). Old sources: index.html panes account/security,
// app.js showSettingsPage / emailSave / passSave.
//
// Password change note: the backend (/api/account/password) revokes every
// OTHER session and reissues this one's cookie — that IS the old
// "signs out all your other sessions" behavior; no extra endpoint exists.

import { BookMarked, BookOpen, Link2 } from "lucide-react";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import { useHealthQuery } from "@/components/shell/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { useAutofillGuard, useMaskedInput } from "@/lib/autofill";
import type { PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";

import { ConnRow, debridPill, errMsg, Field, initial, PaneSection, Pill, RoleBadge } from "../shared";

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

  const savePassword = async () => {
    try {
      await api("/account/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: curPass, newPassword: newPass }),
      });
      setCurPass("");
      setNewPass("");
      toast("Password updated");
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const [rdState, rdLabel] = debridPill(health?.realdebrid);
  const ani = !!health?.trackers.anilist;
  const mal = !!health?.trackers.mal;

  return (
    <div className="grid grid-cols-1 gap-4">
      <PaneSection>
        {/* profile header (old .profile) */}
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary/15 text-lg font-semibold text-primary">
            {initial(user?.username)}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-base font-semibold">{user?.username ?? "—"}</span>
              {user ? <RoleBadge role={user.role} /> : null}
            </div>
            <div className="text-sm text-muted-foreground">Your account &amp; connections</div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <ConnRow
            icon={<Link2 className="h-4 w-4" />}
            name="Real-Debrid"
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
        </div>
      </PaneSection>

      <PaneSection title="Security">
        <Field label="Email" htmlFor="acctEmail" hint="Used to deliver password-reset links.">
          <div className="flex flex-wrap gap-2">
            <Input
              id="acctEmail"
              type="email"
              inputMode="email"
              {...emailGuard}
              className="w-full flex-1 sm:w-auto"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button className="shrink-0" onClick={() => void saveEmail()}>
              Save
            </Button>
          </div>
        </Field>

        <div>
          <h3 className="text-sm font-semibold">Password</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Changing your password signs out all your other sessions.
          </p>
        </div>
        <Field label="Current password" htmlFor="curPass">
          <Input
            id="curPass"
            {...curMask}
            className={cn(curMask.className, "w-full sm:max-w-sm")}
            placeholder="Current password"
            value={curPass}
            onChange={(e) => setCurPass(e.target.value)}
          />
        </Field>
        <Field label="New password" htmlFor="newPass">
          <Input
            id="newPass"
            {...newMask}
            className={cn(newMask.className, "w-full sm:max-w-sm")}
            placeholder="At least 8 characters"
            value={newPass}
            onChange={(e) => setNewPass(e.target.value)}
          />
        </Field>
        <div>
          <Button onClick={() => void savePassword()}>Update password</Button>
        </div>
      </PaneSection>
    </div>
  );
}
