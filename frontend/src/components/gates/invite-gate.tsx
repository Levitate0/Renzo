"use client";

// Invite acceptance gate — reached via /invite/<token> (old links) or
// /?invite=<token>. Loads the invite info (role note, preset username), then
// creates the account. Old showInvite/submitInvite (app.js:2071-2109).

import React, { useEffect, useState } from "react";

import { GateBanner, GateError, GateShell } from "@/components/gates/gate-shell";
import { PwMeter } from "@/components/gates/pw-meter";
import { useAuth } from "@/contexts/auth-context";
import type { AuthSuccess, InviteInfo } from "@/lib/types";

export function InviteGate({ token }: { token: string }) {
  const { completeAuth } = useAuth();
  const [username, setUsername] = useState("");
  const [usernameLocked, setUsernameLocked] = useState(false);
  const [roleNote, setRoleNote] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const info = (await fetch(`/api/auth/invite/${encodeURIComponent(token)}`, {
          credentials: "same-origin",
        }).then((r) => r.json())) as InviteInfo;
        if (!alive) return;
        if (!info.valid) {
          setError(info.error || "Invalid invite");
          setInvalid(true);
          return;
        }
        setRoleNote(`You'll join as a ${info.role}.`);
        if (info.presetUsername && info.username) {
          setUsername(info.username);
          setUsernameLocked(true);
        }
      } catch {
        if (alive) setError("Could not load invite");
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  async function submit() {
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/auth/invite/accept", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, username: username.trim(), password }),
      });
      const data = (await r.json().catch(() => ({}))) as AuthSuccess & { error?: string };
      if (!r.ok) throw new Error(data.error || "failed");
      completeAuth(data.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60";
  const labelCls = "fld flex flex-col gap-1 text-sm font-medium";

  return (
    <GateShell wide>
      <GateBanner />
      <h2 className="setup-title text-center text-lg font-semibold">
        You&apos;re invited to Renzo
      </h2>
      <p className="muted-note text-center text-sm text-muted-foreground">
        Create your account to join. <span>{roleNote}</span>
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={labelCls}>
          Username
          <input
            type="text"
            placeholder="Choose a username"
            autoComplete="username"
            className={inputCls}
            value={username}
            disabled={usernameLocked}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label className={labelCls}>
          Password
          <input
            type="password"
            placeholder="At least 8 characters"
            autoComplete="new-password"
            className={inputCls}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Confirm password
          <input
            type="password"
            placeholder="Re-enter password"
            autoComplete="new-password"
            className={inputCls}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <PwMeter value={password} />
        <button
          type="submit"
          disabled={busy || invalid}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Create account &amp; join
        </button>
      </form>
      <GateError>{error}</GateError>
    </GateShell>
  );
}
