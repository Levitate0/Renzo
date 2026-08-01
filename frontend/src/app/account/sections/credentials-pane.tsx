"use client";

// Required credentials pane — RD token, AllDebrid key, preferred provider,
// Jimaku key, AniList/MAL connect. Ports public/index.html (credentials pane)
// + app.js 2446-2568 (saves, health pills, connectTracker/watchTrackerConnect
// popup + postMessage + /health polling fallback).
//
// Persist-first semantics live server-side (/account/realdebrid saves the
// token BEFORE validating) — the UI just reports the returned premium state.

import { useQueryClient } from "@tanstack/react-query";
import { BookMarked, BookOpen, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useHealthQuery } from "@/components/shell/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TvSelect } from "@/components/ui/tv-select";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { useMaskedInput } from "@/lib/autofill";
import type { DebridSaveResponse, Health, PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";

import { ConnRow, debridPill, errMsg, Field, PaneSection, Pill } from "@/components/settings/shared";

// Auth-site path segment per provider (old AUTHSITE_PROVIDER).
const AUTHSITE_PROVIDER = { anilist: "anilist", mal: "myanimelist" } as const;
type Tracker = keyof typeof AUTHSITE_PROVIDER;

export function CredentialsPane() {
  const { user, updateUser } = useAuth();
  const { data: health, refetch } = useHealthQuery();
  const qc = useQueryClient();

  const [rdToken, setRdToken] = useState("");
  const [adKey, setAdKey] = useState("");
  const [jimakuKey, setJimakuKey] = useState("");
  const [aniToken, setAniToken] = useState("");
  const [malToken, setMalToken] = useState("");
  const rdMask = useMaskedInput();
  const adMask = useMaskedInput();
  const jimakuMask = useMaskedInput();
  const aniMask = useMaskedInput();
  const malMask = useMaskedInput();

  // Latest health for event handlers (origin checks, connect URLs).
  const healthRef = useRef<Health | undefined>(health);
  healthRef.current = health;

  // --- tracker connect: popup + postMessage + poll fallback -----------------
  const pollers = useRef<Partial<Record<Tracker, ReturnType<typeof setInterval>>>>({});

  const stopPoll = useCallback((p: Tracker) => {
    const t = pollers.current[p];
    if (t) clearInterval(t);
    delete pollers.current[p];
  }, []);

  const onTrackerConnected = useCallback(
    (provider: Tracker) => {
      stopPoll(provider);
      toast(`${provider === "anilist" ? "AniList" : "MyAnimeList"} connected ✓`);
      updateUser(provider === "anilist" ? { anilistConnected: true } : { malConnected: true });
      void qc.invalidateQueries({ queryKey: ["health"] });
      void qc.invalidateQueries({ queryKey: ["library"] }); // old: reload library view
    },
    [qc, stopPoll, updateUser],
  );

  // Poll /health until the tracker flips connected (~2 min, old watchTrackerConnect).
  const watchTrackerConnect = useCallback(
    (provider: Tracker) => {
      stopPoll(provider);
      let tries = 0;
      pollers.current[provider] = setInterval(() => {
        tries++;
        void refetch().then((res) => {
          const h = res.data;
          const on = provider === "anilist" ? h?.trackers.anilist : h?.trackers.mal;
          if (on) onTrackerConnected(provider);
          else if (tries >= 40) stopPoll(provider);
        });
      }, 3000);
    },
    [onTrackerConnected, refetch, stopPoll],
  );

  // Per-user OAuth via OUR backend + the auth site's machine API. The old flow
  // opened the auth site's /connect page, which is the OWNER's central dashboard
  // connection and sits behind the dashboard password — users saw a password
  // gate instead of AniList (reported as "wrong url for OAuth"). Now: the
  // backend mints {authUrl, state}, the popup goes STRAIGHT to AniList/MAL, and
  // we poll our own /oauth/:provider/poll until the tokens land on this user.
  const connectTracker = useCallback(
    async (provider: Tracker) => {
      const site = healthRef.current?.authsite;
      if (!site?.enabled) {
        toast("Auth site not configured");
        return;
      }
      let startRes: { authUrl: string; state: string };
      try {
        startRes = await api<{ authUrl: string; state: string }>(`/account/oauth/${provider}/start`, { method: "POST" });
      } catch (e) {
        toast("Couldn't start the connection: " + (e instanceof Error ? e.message : e));
        return;
      }
      const w = window.open(startRes.authUrl, "fsa-oauth", "width=640,height=820,menubar=no,toolbar=no");
      if (!w) {
        toast("Popup blocked — allow popups, then try again");
        return;
      }
      // Poll our backend for up to 3 minutes; it stores the tokens on this user.
      stopPoll(provider);
      let ticks = 0;
      pollers.current[provider] = setInterval(async () => {
        ticks++;
        try {
          const r = await api<{ pending?: boolean; connected?: boolean }>(
            `/account/oauth/${provider}/poll`,
            { method: "POST", body: JSON.stringify({ state: startRes.state }) },
          );
          if (r.connected) {
            stopPoll(provider);
            onTrackerConnected(provider);
          }
        } catch {
          /* transient — keep polling */
        }
        if (ticks > 60) {
          stopPoll(provider);
          toast("Connection timed out — try again");
        }
      }, 3000);
    },
    [onTrackerConnected, stopPoll],
  );

  // Auth site postMessages renzo-oauth success/error back to this window.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const site = healthRef.current?.authsite;
      if (!site?.url) return;
      let origin: string;
      try {
        origin = new URL(site.url).origin;
      } catch {
        return;
      }
      if (e.origin !== origin || !e.data || typeof e.data !== "object") return; // trust only the auth site
      const data = e.data as { type?: string; provider?: string };
      const provider: Tracker | null =
        data.provider === "myanimelist" ? "mal" : data.provider === "anilist" ? "anilist" : null;
      if (!provider) return;
      if (data.type === "oauth-success") onTrackerConnected(provider);
      else if (data.type === "oauth-error") {
        stopPoll(provider);
        toast("Connection was cancelled or failed");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onTrackerConnected, stopPoll]);

  // Returning to this tab after linking on the auth site refreshes status
  // (old: focus listener gated on the settings modal being open — here the
  // pane is only mounted while open).
  useEffect(() => {
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  // Clear any pollers on unmount.
  useEffect(() => {
    const map = pollers.current;
    return () => Object.values(map).forEach((t) => t && clearInterval(t));
  }, []);

  // --- debrid / jimaku saves ------------------------------------------------

  const saveRd = async (token: string) => {
    try {
      const r = await api<DebridSaveResponse>("/account/realdebrid", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setRdToken("");
      updateUser({ realDebridConnected: r.realDebridConnected, debrid: r.debrid });
      toast(
        r.realDebridConnected
          ? r.premium
            ? "Real-Debrid connected"
            : "Connected — but account is NOT premium; downloads need premium"
          : "Real-Debrid disconnected",
      );
      void qc.invalidateQueries({ queryKey: ["health"] });
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const saveAd = async (key: string) => {
    try {
      const r = await api<DebridSaveResponse>("/account/alldebrid", {
        method: "POST",
        body: JSON.stringify({ key }),
      });
      setAdKey("");
      updateUser({ allDebridConnected: r.allDebridConnected, debrid: r.debrid });
      toast(r.allDebridConnected ? "AllDebrid connected" : "AllDebrid disconnected");
      void qc.invalidateQueries({ queryKey: ["health"] });
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const saveDebridPref = async (provider: string) => {
    try {
      await api("/account/debrid", { method: "POST", body: JSON.stringify({ provider }) });
      updateUser({ debrid: provider === "alldebrid" ? "alldebrid" : "realdebrid" });
      toast(`Using ${provider === "alldebrid" ? "AllDebrid" : "Real-Debrid"}`);
      void qc.invalidateQueries({ queryKey: ["health"] });
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const saveJimaku = async (key: string) => {
    try {
      const u = await api<PublicUser>("/account/jimaku", {
        method: "POST",
        body: JSON.stringify({ key }),
      });
      setJimakuKey("");
      updateUser({ jimakuConnected: u.jimakuConnected });
      toast(u.jimakuConnected ? "Jimaku connected — subtitles enabled" : "Jimaku key removed");
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const saveTracker = async (field: "anilistToken" | "malToken", val: string) => {
    try {
      await api("/account/trackers", { method: "POST", body: JSON.stringify({ [field]: val }) });
      if (field === "anilistToken") setAniToken("");
      else setMalToken("");
      toast(val ? "Saved" : "Token cleared");
      void qc.invalidateQueries({ queryKey: ["health"] });
    } catch (e) {
      toast(errMsg(e));
    }
  };

  // --- render ---------------------------------------------------------------

  const [rdState, rdLabel] = debridPill(health?.realdebrid);
  const [adState, adLabel] = debridPill(health?.alldebrid);
  const rdOn = !!health && health.realdebrid !== "not-connected";
  const adOn = !!health && health.alldebrid !== "not-connected";
  const bothDebrid = rdOn && adOn;
  const ani = !!health?.trackers.anilist;
  const mal = !!health?.trackers.mal;
  const site = health?.authsite;

  return (
    <div className="grid grid-cols-1 gap-4">
      <PaneSection
        title="Required credentials"
        sub={
          <>
            Each account uses its <b>own</b> credentials. Real-Debrid is required to stream &amp;
            download; a Jimaku key enables anime subtitles; connect AniList <i>or</i> MyAnimeList
            for list import &amp; scrobbling.
          </>
        }
      >
        <Field
          label="Real-Debrid API token"
          htmlFor="rdToken"
          pill={<Pill state={rdState}>{rdLabel}</Pill>}
          hint={
            <>
              All torrent traffic routes through a debrid service, never your home IP.{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href="https://real-debrid.com/apitoken"
                target="_blank"
                rel="noreferrer"
              >
                Get your token →
              </a>
            </>
          }
        >
          <div className="flex flex-wrap gap-2">
            <Input
              id="rdToken"
              {...rdMask}
              className={cn(rdMask.className, "w-full flex-1 sm:w-auto")}
              placeholder="Paste your Real-Debrid API token"
              value={rdToken}
              onChange={(e) => setRdToken(e.target.value)}
            />
            <Button className="shrink-0" onClick={() => void saveRd(rdToken.trim())}>
              Save
            </Button>
            {rdOn && (
              <Button variant="outline" className="shrink-0" onClick={() => void saveRd("")}>
                Disconnect
              </Button>
            )}
          </div>
        </Field>

        <Field
          label="AllDebrid API key"
          htmlFor="adKey"
          pill={<Pill state={adState}>{adLabel}</Pill>}
          hint={
            <>
              Alternative to Real-Debrid — connect either (or both).{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href="https://alldebrid.com/apikeys/"
                target="_blank"
                rel="noreferrer"
              >
                Get your key →
              </a>
            </>
          }
        >
          <div className="flex flex-wrap gap-2">
            <Input
              id="adKey"
              {...adMask}
              className={cn(adMask.className, "w-full flex-1 sm:w-auto")}
              placeholder="Paste your AllDebrid API key"
              value={adKey}
              onChange={(e) => setAdKey(e.target.value)}
            />
            <Button className="shrink-0" onClick={() => void saveAd(adKey.trim())}>
              Save
            </Button>
            {adOn && (
              <Button variant="outline" className="shrink-0" onClick={() => void saveAd("")}>
                Disconnect
              </Button>
            )}
          </div>
        </Field>

        {bothDebrid && (
          <Field
            label="Preferred debrid service"
            hint="Used for streaming + downloads when both are connected."
          >
            <TvSelect
              value={health?.debrid ?? "realdebrid"}
              onValueChange={(v) => void saveDebridPref(v)}
              className="w-full sm:w-64"
              options={[
                { value: "realdebrid", label: "Real-Debrid" },
                { value: "alldebrid", label: "AllDebrid" },
              ]}
            />
          </Field>
        )}

        <Field
          label="Jimaku API key"
          htmlFor="jimakuKey"
          pill={
            <Pill state={user?.jimakuConnected ? "ok" : "warn"}>
              {user?.jimakuConnected ? "Connected" : "Not connected"}
            </Pill>
          }
          hint={
            <>
              <b>Required for subtitles</b> — enables anime captions and saves them with each
              download.{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href="https://jimaku.cc/login"
                target="_blank"
                rel="noreferrer"
              >
                Sign in at jimaku.cc
              </a>{" "}
              → Account → API key.
            </>
          }
        >
          <div className="flex flex-wrap gap-2">
            <Input
              id="jimakuKey"
              {...jimakuMask}
              className={cn(jimakuMask.className, "w-full flex-1 sm:w-auto")}
              placeholder="Paste your Jimaku API key"
              value={jimakuKey}
              onChange={(e) => setJimakuKey(e.target.value)}
            />
            <Button className="shrink-0" onClick={() => void saveJimaku(jimakuKey.trim())}>
              Save
            </Button>
            {user?.jimakuConnected && (
              <Button variant="outline" className="shrink-0" onClick={() => void saveJimaku("")}>
                Disconnect
              </Button>
            )}
          </div>
        </Field>
      </PaneSection>

      <PaneSection
        title="AniList / MyAnimeList"
        sub={
          <>
            <b>Connect just one</b> — enough to import your list and auto-scrobble. Connecting opens
            the auth site in a popup; sign in once and it manages your tokens.
          </>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            title="Re-check connection status"
            onClick={() => {
              void refetch().then(() => toast("Status refreshed"));
            }}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-2">
          <ConnRow
            icon={<BookOpen className="h-4 w-4" />}
            name="AniList"
            desc={ani ? "Connected — importing & scrobbling" : "Not linked yet"}
            pill={<Pill state={health ? (ani ? "ok" : "err") : "muted"}>{health ? (ani ? "Connected" : "Not linked") : "checking…"}</Pill>}
            action={
              site?.enabled && site.url ? (
                <Button variant="outline" size="sm" onClick={() => connectTracker("anilist")}>
                  {ani ? "Reconnect ↗" : "Connect ↗"}
                </Button>
              ) : undefined
            }
          />
          <ConnRow
            icon={<BookMarked className="h-4 w-4" />}
            name="MyAnimeList"
            desc={mal ? "Connected — importing & scrobbling" : "Not linked yet"}
            pill={<Pill state={health ? (mal ? "ok" : "err") : "muted"}>{health ? (mal ? "Connected" : "Not linked") : "checking…"}</Pill>}
            action={
              site?.enabled && site.url ? (
                <Button variant="outline" size="sm" onClick={() => connectTracker("mal")}>
                  {mal ? "Reconnect ↗" : "Connect ↗"}
                </Button>
              ) : undefined
            }
          />
        </div>

        <details className="rounded-lg border border-border bg-background/40 px-3 py-2">
          <summary className="cursor-pointer select-none text-sm text-muted-foreground">
            Advanced · paste a token manually
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-4">
            <p className="text-xs text-muted-foreground">
              Optional. Overrides the auth-site token for your account only.
            </p>
            <Field label="AniList access token" htmlFor="anilistToken">
              <div className="flex flex-wrap gap-2">
                <Input
                  id="anilistToken"
                  {...aniMask}
                  className={cn(aniMask.className, "w-full flex-1 sm:w-auto")}
                  placeholder="AniList token"
                  value={aniToken}
                  onChange={(e) => setAniToken(e.target.value)}
                />
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void saveTracker("anilistToken", aniToken.trim())}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => void saveTracker("anilistToken", "")}
                >
                  Clear
                </Button>
              </div>
            </Field>
            <Field label="MyAnimeList access token" htmlFor="malToken">
              <div className="flex flex-wrap gap-2">
                <Input
                  id="malToken"
                  {...malMask}
                  className={cn(malMask.className, "w-full flex-1 sm:w-auto")}
                  placeholder="MAL token"
                  value={malToken}
                  onChange={(e) => setMalToken(e.target.value)}
                />
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void saveTracker("malToken", malToken.trim())}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => void saveTracker("malToken", "")}
                >
                  Clear
                </Button>
              </div>
            </Field>
          </div>
        </details>
      </PaneSection>
    </div>
  );
}
