"use client";

// First-run owner setup — two steps, same as the old #setupGate:
//   1. owner username + password (+ confirm, strength meter, shape validation)
//   2. optional Real-Debrid token (skippable; skipped entirely when the owner
//      inherited an env-seeded token). Old app.js:2196-2276.
// (The old app has NO invite-links step in setup — invites live in Settings.)

import React, { useState } from "react";
import { toast } from "sonner";

import { GateBanner, GateError, GateShell } from "@/components/gates/gate-shell";
import { PwMeter } from "@/components/gates/pw-meter";
import { useAuth } from "@/contexts/auth-context";
import { api, ApiError } from "@/lib/api";
import type { AuthSuccess, DebridSaveResponse, PublicUser } from "@/lib/types";

export function SetupGate() {
  const { completeAuth } = useAuth();
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [rdToken, setRdToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState<PublicUser | null>(null);

  async function submitOwner() {
    setError("");
    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username.trim())) {
      setError("Username: 2–32 chars — letters, digits, . _ -");
      return;
    }
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
      const r = await fetch("/api/auth/setup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = (await r.json().catch(() => ({}))) as AuthSuccess & { error?: string };
      if (!r.ok) throw new Error(data.error || "setup failed");
      setOwner(data.user);
      // Env-seeded Real-Debrid token -> nothing to connect, finish immediately.
      if (data.user.realDebridConnected) {
        toast("Owner account created");
        completeAuth(data.user);
        return;
      }
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish(token: string) {
    setError("");
    let u = owner;
    if (token && u) {
      setBusy(true);
      try {
        const r = await api<DebridSaveResponse>("/account/realdebrid", {
          method: "POST",
          body: JSON.stringify({ token }),
        });
        u = { ...u, realDebridConnected: r.realDebridConnected };
        if (r.realDebridConnected && !r.premium) {
          toast("Connected — note: this Real-Debrid account is not premium");
        }
      } catch (e) {
        // Stay on the RD step so they can retry or skip.
        setError(e instanceof ApiError ? e.message : String(e));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    if (u) completeAuth(u);
  }

  const inputCls =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring";
  const labelCls = "fld flex flex-col gap-1 text-sm font-medium";

  return (
    <GateShell wide>
      <GateBanner />
      <h2 className="setup-title text-center text-lg font-semibold">
        Welcome — let&apos;s set up your server
      </h2>

      {step === 1 && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitOwner();
          }}
        >
          <p className="muted-note text-sm text-muted-foreground">
            Create the <strong>owner</strong> account. It&apos;s the only admin, and the only
            account that can add other users. Choose a strong password.
          </p>
          <label className={labelCls}>
            Username
            <input
              type="text"
              placeholder="e.g. levit"
              autoComplete="username"
              className={inputCls}
              value={username}
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
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Create owner &amp; continue →
          </button>
        </form>
      )}

      {step === 2 && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void finish(rdToken.trim());
          }}
        >
          <p className="muted-note text-sm text-muted-foreground">
            Almost done. Connect <strong>Real-Debrid</strong> — it&apos;s required to stream and
            download, and keeps all torrent traffic off your home IP.{" "}
            <a
              href="https://real-debrid.com/apitoken"
              target="_blank"
              rel="noreferrer"
              className="muted-link underline underline-offset-4"
            >
              Get your token →
            </a>
          </p>
          <label className={labelCls}>
            Real-Debrid API token
            <input
              type="password"
              placeholder="Paste token (or skip and add later)"
              autoComplete="off"
              className={inputCls}
              value={rdToken}
              onChange={(e) => setRdToken(e.target.value)}
              autoFocus
            />
          </label>
          <div className="setup-actions flex flex-col gap-2">
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Save &amp; finish
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void finish("")}
              className="w-full rounded-md border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              Skip for now
            </button>
          </div>
        </form>
      )}

      <GateError>{error}</GateError>
    </GateShell>
  );
}
