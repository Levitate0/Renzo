"use client";

// Login gate — commit bbe2b84 semantics: a REAL <form> so the Android TV
// keyboard's Go editor action submits (the IME fires an editor action, not a
// reliable DOM keydown). Username Enter/Next moves to the password field.
// Login/forgot call fetch directly (not api()) so a 401 can't re-fire the gate.

import React, { useRef, useState } from "react";
import { toast } from "sonner";

import { GateBanner, GateError, GateShell } from "@/components/gates/gate-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  return (
    // Shiori's login card: max-w-md, centred banner, "Enter your credentials"
    // description, labelled fields, remember row, full-width submit, and the
    // forgot link centred at the foot of the form.
    <GateShell wide>
      <GateBanner />
      <p className="muted-note text-center text-sm text-muted-foreground">
        Enter your credentials to log in
      </p>
      <form
        id="authForm"
        className="auth-form flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* Above the fields, as on Shiori — an error under the button is easy
            to miss when the button is what you just pressed. */}
        <GateError>{error}</GateError>
        <div className="space-y-2">
          <Label htmlFor="authUser">Username</Label>
          <Input
            id="authUser"
            type="text"
            placeholder="Enter your username"
            autoComplete="username"
            enterKeyHint="next"
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
        </div>
        <div className="space-y-2">
          <Label htmlFor="authPass">Password</Label>
          <Input
            id="authPass"
            ref={passRef}
            type="password"
            placeholder="Enter your password"
            autoComplete="current-password"
            enterKeyHint="go"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {/* Native checkbox, not Shiori's Radix one: the gate is a tvnav
            blocking root and a real <input> is what the D-pad reliably lands
            on. Same look via accent-color. */}
        <label className="remember-row flex items-center gap-2 text-sm text-muted-foreground">
          <input
            id="authRemember"
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 accent-[hsl(var(--primary))]"
          />
          <span>Remember me</span>
        </label>
        <Button id="authSubmit" type="submit" className="w-full" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </Button>
        <div className="text-center text-sm">
          <button
            type="button"
            onClick={() => void forgot()}
            disabled={busy}
            className="link-btn text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Forgot password?
          </button>
        </div>
      </form>
    </GateShell>
  );
}
