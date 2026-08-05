"use client";

// ---------------------------------------------------------------------------
// Auth state — ports the old boot() / startApp() / showAuthGate() flow from
// public/app.js (~1920-2330). Children ALWAYS render; gate display is pure
// state that GateHost (components/gates/gate-host.tsx) turns into overlays.
//
// Boot order (same as old):
//   /invite/<token> path or ?invite=<token>  -> invite gate
//   ?reset=<token>                           -> reset gate
//   fetch /api/auth/me:
//     network failure -> offline gate (phone/desktop; TV gets nothing)
//     { setupRequired } -> first-run owner setup gate
//     401 -> login gate
//     { user } -> app
// Any later API 401 fires AUTH_GATE_EVENT -> login gate (no redirect loops).
// ---------------------------------------------------------------------------

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { AUTH_GATE_EVENT, openSettings } from "@/lib/api";
import { isTv } from "@/lib/tv";
import type { MeResponse, PublicUser } from "@/lib/types";

export type GateState =
  | { kind: "none" }
  | { kind: "login" }
  | { kind: "setup" }
  | { kind: "reset"; token: string }
  | { kind: "invite"; token: string }
  | { kind: "offline" }; // cold-launch, server unreachable (phone/desktop only)

interface AuthContextValue {
  user: PublicUser | null;
  loading: boolean;
  gate: GateState;
  /** Re-fetch /api/auth/me and reconcile state. */
  refresh: () => Promise<void>;
  /** POST /api/auth/logout then full reload (old behavior — clears everything). */
  logout: () => Promise<void>;
  /** Called by a gate after a successful login/setup/reset/invite. */
  completeAuth: (user: PublicUser) => void;
  /** Force the login gate (e.g. from a 401). */
  showLogin: () => void;
  /** Patch the cached user (e.g. after connecting Real-Debrid). */
  updateUser: (patch: Partial<PublicUser>) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function urlTokens(): { invite: string | null; reset: string | null } {
  if (typeof window === "undefined") return { invite: null, reset: null };
  const params = new URLSearchParams(window.location.search);
  // Old links are /invite/<token> paths; the port also accepts ?invite=<token>.
  const pathInvite = /^\/invite\/([\w-]+)\/?$/.exec(window.location.pathname)?.[1] ?? null;
  return {
    invite: params.get("invite") ?? pathInvite,
    reset: params.get("reset"),
  };
}

/** Nudge to connect a debrid service (old startApp tail) — not when deep-linked
 *  into the player/detail overlays, where the toast would be instantly buried,
 *  and not on /tv: that page is a task someone was sent to by a TV, and on a
 *  debrid-less account (i.e. a fresh install pairing its first TV) the nudge's
 *  router push threw them onto the credentials page mid-approval — verified
 *  end to end, the code they had just typed went with it.
 *  NEVER navigate on TV: a remote can't type API tokens, and auto-opening the
 *  credentials page trapped debrid-less accounts there on every launch (the
 *  settings-family `modal` root scopes D-pad focus inside the page — reported
 *  as "locked to the 3-bar menu", which is the collapsed section list). */
function maybeNudgeCredentials(user: PublicUser): void {
  if (typeof window === "undefined") return;
  const p = window.location.pathname;
  if (p.startsWith("/watch") || p.startsWith("/title") || p.startsWith("/tv")) return;
  if (user.realDebridConnected || user.allDebridConnected) return;
  if (isTv()) {
    toast("Connect a debrid service to this account in the Renzo web app to stream");
    return;
  }
  toast("Connect Real-Debrid or AllDebrid in Settings to start streaming");
  openSettings("credentials");
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<GateState>({ kind: "none" });
  const nudged = useRef(false);
  // Legal here: QueryProvider wraps AuthProvider in app/layout.tsx.
  const queryClient = useQueryClient();

  const refresh = useCallback(async () => {
    let info: MeResponse;
    let status = 0;
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      status = res.status;
      info = res.ok ? ((await res.json()) as MeResponse) : {};
    } catch {
      // Server unreachable: offline mode so saved downloads stay watchable.
      // TVs have no offline storage — show nothing (tvnav still owns focus).
      setUser(null);
      setGate(isTv() ? { kind: "none" } : { kind: "offline" });
      setLoading(false);
      return;
    }
    if (info.setupRequired) {
      setUser(null);
      setGate({ kind: "setup" });
    } else if (status === 401 || !info.user) {
      setUser(null);
      setGate({ kind: "login" });
    } else {
      setUser(info.user);
      setGate({ kind: "none" });
      if (!nudged.current) {
        nudged.current = true;
        maybeNudgeCredentials(info.user);
      }
    }
    setLoading(false);
  }, []);

  // Boot: invite / reset links pre-empt the /me check entirely (old boot()).
  useEffect(() => {
    const { invite, reset } = urlTokens();
    if (invite) {
      setGate({ kind: "invite", token: invite });
      setLoading(false);
      return;
    }
    if (reset) {
      setGate({ kind: "reset", token: reset });
      setLoading(false);
      return;
    }
    void refresh();
  }, [refresh]);

  // Any API 401 anywhere -> a REAL forced logout (never while an auth flow is
  // already up). Raising the gate alone was cosmetic: `user` stayed populated,
  // so every `enabled: !!user` query kept firing against a dead session — jobs
  // re-polled each 4s, each one 401ing and re-raising this event — and the
  // previous session's library/history/jobs stayed in the query cache, ready to
  // be shown to whoever logged in next.
  useEffect(() => {
    const onUnauthorized = () => {
      setGate((g) => {
        if (g.kind !== "none" && g.kind !== "offline") return g;
        setUser(null);        // stops every enabled:!!user poll immediately
        queryClient.clear();  // nothing from the dead session survives re-login
        return { kind: "login" };
      });
    };
    window.addEventListener(AUTH_GATE_EVENT, onUnauthorized);
    return () => window.removeEventListener(AUTH_GATE_EVENT, onUnauthorized);
  }, [queryClient]);

  const completeAuth = useCallback((u: PublicUser) => {
    // Clear any ?reset= / /invite/ token from the URL (old history.replaceState).
    if (typeof window !== "undefined") {
      const { invite, reset } = urlTokens();
      if (invite || reset) window.history.replaceState(null, "", "/");
    }
    // Signing in starts a clean slate. Errored queries from the expired session
    // do not refetch on a re-render, so without this the pages sat on empty
    // grids until a poll or staleTime expired — and a DIFFERENT user signing in
    // would briefly be shown the previous user's library, history and jobs.
    queryClient.clear();
    setUser(u);
    setGate({ kind: "none" });
    setLoading(false);
    nudged.current = true;
    maybeNudgeCredentials(u);
  }, [queryClient]);

  const showLogin = useCallback(() => {
    setUser(null);
    setGate({ kind: "login" });
    setLoading(false);
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(
      () => {},
    );
    // Full reload, exactly like the old app: resets every in-memory cache and
    // re-runs boot(), which lands on the login gate.
    window.location.href = "/";
  }, []);

  const updateUser = useCallback((patch: Partial<PublicUser>) => {
    setUser((u) => (u ? { ...u, ...patch } : u));
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, gate, refresh, logout, completeAuth, showLogin, updateUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
