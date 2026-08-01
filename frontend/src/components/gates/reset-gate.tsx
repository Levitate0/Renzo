"use client";

// Password reset gate — reached via /?reset=<token> from an emailed link.
// Validates the token first (old showReset, app.js:2113); an invalid link
// toasts and falls back to the login gate.

import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import { GateBanner, GateError, GateShell } from "@/components/gates/gate-shell";
import { PwMeter } from "@/components/gates/pw-meter";
import { useAuth } from "@/contexts/auth-context";
import type { AuthSuccess, ResetInfo } from "@/lib/types";

export function ResetGate({ token }: { token: string }) {
  const { completeAuth, showLogin } = useAuth();
  const [username, setUsername] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const info = (await fetch(`/api/auth/reset/${encodeURIComponent(token)}`, {
          credentials: "same-origin",
        }).then((r) => r.json())) as ResetInfo;
        if (!alive) return;
        if (!info.valid) {
          toast(info.error || "This reset link is invalid or has expired");
          window.history.replaceState(null, "", "/");
          showLogin();
          return;
        }
        setUsername(info.username ?? "your account");
      } catch {
        if (!alive) return;
        toast("Could not open reset link");
        showLogin();
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, showLogin]);

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
      const r = await fetch("/api/auth/reset", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
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
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring";

  return (
    <GateShell>
      <GateBanner />
      <p className="muted-note text-center text-sm text-muted-foreground">
        Set a new password for <strong>{username ?? "…"}</strong>.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="password"
          placeholder="New password (min 8)"
          autoComplete="new-password"
          className={inputCls}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          placeholder="Confirm new password"
          autoComplete="new-password"
          className={inputCls}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <PwMeter value={password} />
        <button
          type="submit"
          disabled={busy || username === null}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Set password &amp; sign in
        </button>
      </form>
      <GateError>{error}</GateError>
    </GateShell>
  );
}
