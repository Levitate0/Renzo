"use client";

// ---------------------------------------------------------------------------
// /tv/ — the TV pairing approval page (docs/TV-PAIRING-RENZO.md §4). The TV
// prints a short code and this URL; the PHONE half lives here.
//
// Flow, deliberately two steps:
//   type the code -> POST /auth/tv/lookup -> show WHAT is being approved
//   (device name + requesting IP + which account) -> explicit Approve / Deny.
// Nothing is granted before the person has seen the device: §3 makes "show
// what is being approved" a security requirement, not a nicety, because the
// only thing standing between a guessed code and someone else's library is
// this screen.
//
// Unauthenticated visitors need no special handling here: AuthProvider's boot
// /auth/me already lands them on the login gate (an overlay, not a redirect),
// and completeAuth only rewrites the URL for ?reset= / /invite/ links — so
// signing in drops them back on /tv/ with the code still in hand. The page
// renders a "sign in first" note underneath rather than an inert form.
//
// LAN-only install: no external fonts, images or scripts on this route — the
// icons are inline SVG (lucide) and the type is the app's own bundled fonts.
// ---------------------------------------------------------------------------

import { CircleAlert, CircleCheck, CircleX, Globe, Tv } from "lucide-react";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

import { PaneSection, RoleBadge } from "@/components/settings/shared";
import { AppShell } from "@/components/shell/app-shell";
import { UserAvatar } from "@/components/shell/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";
import { ApiError, tvApprove, tvDeny, tvLookup } from "@/lib/api";
import type { PublicUser, TvPairingRequest } from "@/lib/types";

// --- the code ---------------------------------------------------------------
// Someone is copying 8 characters off a television across a room, so accept
// what they type however they type it: lower case, spaces, no dash, a dash in
// the wrong place. Ambiguous characters are NOT transliterated — the server's
// alphabet already excludes both halves of each confusable pair (§3), so
// mapping O->0 could only ever break a code that was typed correctly.

const CODE_LEN = 8; // XXXX-XXXX

const normalizeCode = (raw: string): string =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);

/** Back to the form the TV displays — that is also what we send the server
 *  (its normalizeUserCode does exactly this, so the two agree by construction). */
const formatCode = (code: string): string =>
  code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

/** Glyphs the code alphabet deliberately omits (§3). Typing one means it was
 *  misread off the screen — advisory only, it never blocks a submit, so a
 *  future alphabet change can't lock anyone out of this page. */
const MISREAD = /[ILO01]/;

// --- failure cases ----------------------------------------------------------
// "Wrong code" and "expired code" are different problems with different next
// steps (§4), and the server splits them further. Verified against the live
// endpoints (src/routes/auth.ts TV_ERRORS):
//   404 unknown · 410 expired · 409 already used · 429 locked/throttled
// The 429 covers both "this code took 5 bad guesses" and "this IP is throttled
// for 15 minutes"; either way "type it again" is useless advice, so the copy
// says to wait and start over.

type Problem = "unknown" | "expired" | "used" | "locked" | "offline" | "other";

function problemFor(e: unknown): { kind: Problem; detail?: string } | null {
  if (e instanceof ApiError) {
    // 401 is already handled globally (forced logout + login gate on top of
    // this page) — a second error message underneath would just be noise.
    if (e.status === 401) return null;
    if (e.status === 404) return { kind: "unknown" };
    if (e.status === 410) return { kind: "expired" };
    if (e.status === 409) return { kind: "used" };
    if (e.status === 429) return { kind: "locked" };
    if (e.network) return { kind: "offline" };
    return { kind: "other", detail: e.message };
  }
  return { kind: "other", detail: e instanceof Error ? e.message : String(e) };
}

function ProblemNote({ problem }: { problem: { kind: Problem; detail?: string } }) {
  const { kind, detail } = problem;
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm"
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-1">
        {kind === "unknown" && (
          <>
            <p className="font-medium">That code isn&apos;t waiting for approval.</p>
            <p className="text-muted-foreground">
              Check it against the TV screen character for character — only the code currently
              on screen works. Codes never contain <b>O</b>, <b>0</b>, <b>I</b>, <b>1</b> or{" "}
              <b>L</b>, so look again at anything that reads like one. If the TV has restarted
              or moved on, ask it for a new code.
            </p>
          </>
        )}
        {kind === "expired" && (
          <>
            <p className="font-medium">That code has expired.</p>
            <p className="text-muted-foreground">
              Codes last about ten minutes. Nothing was granted — go back to the TV, start
              pairing again, and type the new code here.
            </p>
          </>
        )}
        {kind === "used" && (
          <>
            <p className="font-medium">That code has already been used.</p>
            <p className="text-muted-foreground">
              Each code is good for one device, once. If the TV is still waiting, start pairing
              again on it and type the new code here.
            </p>
          </>
        )}
        {kind === "locked" && (
          <>
            <p className="font-medium">Too many attempts.</p>
            <p className="text-muted-foreground">
              Codes lock themselves after a few wrong guesses. Wait about fifteen minutes, then
              start pairing again on the TV for a fresh code — retyping won&apos;t help before
              then.
            </p>
          </>
        )}
        {kind === "offline" && (
          <>
            <p className="font-medium">Couldn&apos;t reach Renzo.</p>
            <p className="text-muted-foreground">
              Check that this phone is on the same network as the server, then try again.
            </p>
          </>
        )}
        {kind === "other" && (
          <>
            <p className="font-medium">Something went wrong.</p>
            <p className="text-muted-foreground">{detail || "Try again in a moment."}</p>
          </>
        )}
      </div>
    </div>
  );
}

// --- countdown --------------------------------------------------------------

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Live "expires in m:ss" for the pending request, so a stale confirm screen
 *  can't sit around inviting a blind Approve. Fires `onExpire` at zero.
 *  The callback lives in a ref: it is re-created on every render, and putting
 *  it in the dep array would tear down and re-arm the interval each tick. */
function useCountdown(expiresAt: string | number | undefined, onExpire: () => void): number {
  const [left, setLeft] = useState(0);
  const expire = useRef(onExpire);
  expire.current = onExpire;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const end = new Date(expiresAt).getTime();
    if (!Number.isFinite(end)) return; // unparseable — just don't show a clock
    const tick = () => {
      const ms = end - Date.now();
      setLeft(ms);
      if (ms <= 0) expire.current();
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [expiresAt]);
  return left;
}

// --- page -------------------------------------------------------------------

type Stage =
  | { kind: "enter" }
  | { kind: "confirm"; code: string; req: TvPairingRequest }
  | { kind: "approved"; deviceName: string }
  | { kind: "denied" };

function TvPairView() {
  const { user } = useAuth();
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "enter" });
  const [problem, setProblem] = useState<{ kind: Problem; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const backToEntry = (p?: { kind: Problem; detail?: string }) => {
    setStage({ kind: "enter" });
    setProblem(p ?? null);
    setBusy(false);
  };

  // Step 1 — look up, never approve. This is the whole point of the two steps.
  const submitCode = async () => {
    if (busy || code.length !== CODE_LEN) return;
    setBusy(true);
    setProblem(null);
    try {
      const req = await tvLookup(formatCode(code));
      setStage({ kind: "confirm", code, req });
    } catch (e) {
      setProblem(problemFor(e));
    } finally {
      setBusy(false);
    }
  };

  // Step 2 — the explicit choice.
  const approve = async (s: Extract<Stage, { kind: "confirm" }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await tvApprove(formatCode(s.code));
      setCode("");
      setStage({ kind: "approved", deviceName: r.deviceName || s.req.deviceName });
      setProblem(null);
    } catch (e) {
      // Expiry between lookup and approve is the common one — say so instead of
      // leaving a dead Approve button on screen.
      backToEntry(problemFor(e) ?? undefined);
    } finally {
      setBusy(false);
    }
  };

  const deny = async (s: Extract<Stage, { kind: "confirm" }>) => {
    if (busy) return;
    setBusy(true);
    try {
      await tvDeny(formatCode(s.code));
      setCode("");
      setStage({ kind: "denied" });
      setProblem(null);
    } catch (e) {
      // A code that already lapsed is denied by omission — treat it as done.
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
        setCode("");
        setStage({ kind: "denied" });
      } else {
        backToEntry(problemFor(e) ?? undefined);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    // `view active` = tvnav page root (CONTRACTS). No `modal` marker: this is a
    // plain page for phones, not a settings-family overlay.
    <section id="view-tv" className="view active mx-auto w-full max-w-xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pair a TV</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Type the code your TV is showing to sign it in to Renzo — no password on the remote.
        </p>
      </div>

      {!user ? (
        // The login gate is already on top of this page; this is what is
        // underneath it, and where the user lands after signing in.
        <PaneSection>
          <p className="text-sm text-muted-foreground">
            Sign in on this phone first — the account you sign in as is the account the TV
            gets. You&apos;ll come straight back here.
          </p>
        </PaneSection>
      ) : stage.kind === "enter" ? (
        <EnterStage
          user={user}
          code={code}
          setCode={setCode}
          busy={busy}
          problem={problem}
          onSubmit={() => void submitCode()}
        />
      ) : stage.kind === "confirm" ? (
        <ConfirmStage
          username={user.username}
          req={stage.req}
          busy={busy}
          onApprove={() => void approve(stage)}
          onDeny={() => void deny(stage)}
          onCancel={() => backToEntry()}
          onExpire={() => backToEntry({ kind: "expired" })}
        />
      ) : stage.kind === "approved" ? (
        <DoneStage
          ok
          title={`${stage.deviceName} is signed in`}
          body="The TV takes it from here — it should finish signing in on its own within a few seconds. You can put your phone down."
          onAgain={() => backToEntry()}
        />
      ) : (
        <DoneStage
          title="Pairing denied"
          body="Nothing was granted and the TV has stopped waiting. If that request wasn't yours, no further action is needed — the code is dead."
          onAgain={() => backToEntry()}
        />
      )}
    </section>
  );
}

// --- stages -----------------------------------------------------------------

function EnterStage({
  user,
  code,
  setCode,
  busy,
  problem,
  onSubmit,
}: {
  user: PublicUser;
  code: string;
  setCode: (c: string) => void;
  busy: boolean;
  problem: { kind: Problem; detail?: string } | null;
  onSubmit: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4">
      <PaneSection>
        <SignedInAs user={user} />

        {/* A real <form> so a phone keyboard's Go/Done submits (same reason the
            login gate is one — see components/gates/login-gate.tsx). */}
        <form
          className="grid grid-cols-1 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <label htmlFor="tvCode" className="text-sm font-medium">
            Code from the TV
          </label>
          <Input
            id="tvCode"
            value={formatCode(code)}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            placeholder="XXXX-XXXX"
            // OTP-ish keyboard hints; case, spaces and the dash are all
            // normalized away, so none of this has to be typed exactly.
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={CODE_LEN + 1}
            autoFocus
            aria-describedby="tvCodeHint"
            className="h-14 text-center font-mono text-2xl tracking-[0.35em] sm:text-3xl"
          />
          <span id="tvCodeHint" className="text-xs leading-relaxed text-muted-foreground">
            Eight characters. Upper or lower case, with or without the dash — it&apos;s all the
            same code.
          </span>
          {MISREAD.test(code) && (
            <span className="text-xs leading-relaxed text-amber-400">
              Codes never contain O, 0, I, 1 or L — those are easy to misread on a TV. Worth a
              second look before you continue.
            </span>
          )}
          <Button type="submit" className="h-11 w-full" disabled={busy || code.length !== CODE_LEN}>
            {busy ? "Checking…" : "Continue"}
          </Button>
        </form>

        {problem ? <ProblemNote problem={problem} /> : null}
      </PaneSection>

      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        Nothing is granted yet — the next screen shows which device is asking, and where from,
        before you approve it. Already paired something?{" "}
        <Link
          href="/account/?section=devices"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Manage paired devices
        </Link>
        .
      </p>
    </div>
  );
}

function ConfirmStage({
  username,
  req,
  busy,
  onApprove,
  onDeny,
  onCancel,
  onExpire,
}: {
  username: string;
  req: TvPairingRequest;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onCancel: () => void;
  onExpire: () => void;
}) {
  const left = useCountdown(req.expiresAt, onExpire);

  return (
    <div className="grid grid-cols-1 gap-4">
      <PaneSection
        title="Approve this device?"
        sub="Check it before you grant it — an approval signs this device in to your account and keeps it signed in."
      >
        <div className="grid grid-cols-1 gap-2">
          <FactRow
            icon={<Tv className="h-4 w-4" />}
            label="Device"
            value={req.deviceName || "Unnamed device"}
          />
          <FactRow
            icon={<Globe className="h-4 w-4" />}
            label="Requested from"
            value={<span className="font-mono text-xs">{req.ip || "unknown"}</span>}
          />
        </div>

        <p className="text-sm text-muted-foreground">
          It will be signed in as <b className="text-foreground">{username}</b> — your library,
          your lists and your debrid connection.
          {left > 0 ? <> This request expires in {mmss(left)}.</> : null}
        </p>

        {/* Full-width stacked buttons: this is a phone screen and the two
            choices must not be a mis-tap apart. */}
        <div className="grid grid-cols-1 gap-2">
          <Button className="h-11 w-full" disabled={busy} onClick={onApprove}>
            {busy ? "Working…" : "Approve"}
          </Button>
          <Button variant="outline" className="h-11 w-full" disabled={busy} onClick={onDeny}>
            Deny
          </Button>
          <Button variant="ghost" size="sm" className="w-full" disabled={busy} onClick={onCancel}>
            Use a different code
          </Button>
        </div>
      </PaneSection>

      <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <p>
          If you didn&apos;t just start pairing on that device — or the address above isn&apos;t
          on your own network — <b className="text-foreground">deny it</b>. Approving hands your
          account to whoever is holding it.
        </p>
      </div>
    </div>
  );
}

function DoneStage({
  ok,
  title,
  body,
  onAgain,
}: {
  ok?: boolean;
  title: string;
  body: string;
  onAgain: () => void;
}) {
  return (
    <PaneSection>
      <div className="flex gap-3">
        {ok ? (
          <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
        ) : (
          <CircleX className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 space-y-1">
          <p className="text-base font-semibold">{title}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="shrink-0" onClick={onAgain}>
          Pair another device
        </Button>
        <Button variant="ghost" className="shrink-0" asChild>
          <Link href="/account/?section=devices">Manage paired devices</Link>
        </Button>
      </div>
    </PaneSection>
  );
}

// --- bits -------------------------------------------------------------------

/** Which account is about to be handed out — unmistakable, per §4. */
function SignedInAs({ user }: { user: PublicUser }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
      <UserAvatar user={user} className="h-9 w-9 text-sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{user.username}</span>
          <RoleBadge role={user.role} />
        </div>
        <div className="text-xs text-muted-foreground">The TV will be signed in as this account</div>
      </div>
    </div>
  );
}

function FactRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-medium">{value}</div>
      </div>
    </div>
  );
}

export default function TvPairPage() {
  return (
    <AppShell>
      <TvPairView />
    </AppShell>
  );
}
