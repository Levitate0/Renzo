"use client";

// Login gate — commit bbe2b84 semantics: a REAL <form> so the Android TV
// keyboard's Go editor action submits (the IME fires an editor action, not a
// reliable DOM keydown). Username Enter/Next moves to the password field.
// Login/forgot call fetch directly (not api()) so a 401 can't re-fire the gate.

import React, { useRef, useState } from "react";
import { toast } from "sonner";

import { GateBanner, GateError, GateShell } from "@/components/gates/gate-shell";
import { useAuth } from "@/contexts/auth-context";
import type { AuthSuccess } from "@/lib/types";

export function LoginGate() {
  const { completeAuth } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const passRef = useRef<HTMLInputElement>(null);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, remember }),
      });
      const data = (await r.json().catch(() => ({}))) as AuthSuccess & { error?: string };
      if (!r.ok) throw new Error(data.error || "failed");
      completeAuth(data.user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg === "failed" ? "Invalid credentials" : msg);
    } finally {
      setBusy(false);
    }
  }

  // Forgot password: username-gated; the response is ALWAYS generic (no
  // account/email enumeration) — old app.js #forgotBtn.
  async function forgot() {
    const u = username.trim();
    if (!u) {
      setError("Enter your username first");
      return;
    }
    setBusy(true);
    try {
      await fetch("/api/auth/forgot", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: u }),
      });
    } catch {
      /* generic regardless */
    }
    setError("");
    toast("If that account exists and has an email set, a reset link was sent.");
    setBusy(false);
  }

  const inputCls =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring";

  return (
    <GateShell>
      <GateBanner />
      <p className="muted-note text-center text-sm text-muted-foreground">
        Sign in to your account.
      </p>
      <form
        id="authForm"
        className="auth-form flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          id="authUser"
          type="text"
          placeholder="Username"
          autoComplete="username"
          enterKeyHint="next"
          className={inputCls}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => {
            // Go/Next from the username field moves on instead of dead-ending.
            if (e.key === "Enter") {
              e.preventDefault();
              passRef.current?.focus();
            }
          }}
          autoFocus
        />
        <input
          id="authPass"
          ref={passRef}
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          enterKeyHint="go"
          className={inputCls}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label className="remember-row flex items-center gap-2 text-sm text-muted-foreground">
          <input
            id="authRemember"
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 accent-[hsl(var(--primary))]"
          />
          <span>Remember me on this device</span>
        </label>
        <button
          id="authSubmit"
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Sign in
        </button>
      </form>
      <GateError>{error}</GateError>
      <button
        type="button"
        onClick={() => void forgot()}
        disabled={busy}
        className="link-btn self-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Forgot password?
      </button>
    </GateShell>
  );
}
