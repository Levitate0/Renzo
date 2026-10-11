"use client";

// Control bar + centre play button + menus — old initPlayer / buildCcMenu
// (app.js:1618-1712), laid out like Crunchyroll's player (and the Hub's desktop
// player, hub/.../PlayerStage.kt): a full-width seek bar, then one row of flat
// icons — skip back / play / skip forward / volume / time on the left,
// subtitles / speed / settings / fullscreen on the right. All controls operate
// directly on the <video> element (the parent owns src/tracks); time/seek/
// volume/rate state lives here. Literal class names (pc-bar, pc-seek,
// pc-vol-slider, cc-menu…) are kept for the player CSS in globals.css.

import {
  Captions,
  Check,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import React, { useEffect, useState } from "react";

import { ccName } from "@/components/player/captions";
import { fmtTime } from "@/components/player/season-utils";
import { cn } from "@/lib/utils";

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface CcState {
  tracks: { lang: string }[];
  active: number;
}

type Menu = "cc" | "speed" | "settings" | null;

function rateLabel(r: number): string {
  return `${r}x`;
}

/** Flat white icon button; hover or an open menu turns it the accent colour. */
function PcIcon({
  id,
  label,
  on,
  onClick,
  children,
}: {
  id?: string;
  label: string;
  on?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      id={id}
      type="button"
      title={label}
      aria-label={label}
      className={cn("pc-btn relative grid h-11 w-11 place-items-center", on && "on")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Crunchyroll's "10" skip glyph: a circular arrow with the seconds inside. */
function Skip10({ back }: { back?: boolean }) {
  const Icon = back ? RotateCcw : RotateCw;
  return (
    <span className="relative grid place-items-center">
      <Icon className="h-[26px] w-[26px]" strokeWidth={2} />
      <span className="absolute text-[8px] font-bold leading-none">10</span>
    </span>
  );
}

export function PlayerControls({
  videoRef,
  paused,
  onToggle,
  cc,
  ccMenuOpen,
  onCcMenuToggle,
  onCcSelect,
  onFullscreen,
  autoplay,
  onAutoplay,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  paused: boolean;
  onToggle: () => void;
  cc: CcState;
  ccMenuOpen: boolean;
  onCcMenuToggle: () => void;
  onCcSelect: (idx: number) => void;
  onFullscreen: () => void;
  autoplay: boolean;
  onAutoplay: (on: boolean) => void;
}) {
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [seekPos, setSeekPos] = useState(0); // 0..1000
  const [scrubbing, setScrubbing] = useState(false);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [menu, setMenu] = useState<Menu>(null);
  const [isFs, setIsFs] = useState(false);

  // The parent still owns whether the caption menu is open (it closes it on
  // stage clicks); the speed/settings menus are local and exclusive with it.
  const open: Menu = ccMenuOpen ? "cc" : menu;
  const toggleMenu = (m: Exclude<Menu, null>) => {
    if (m === "cc") {
      setMenu(null);
      onCcMenuToggle();
      return;
    }
    if (ccMenuOpen) onCcMenuToggle();
    setMenu((cur) => (cur === m ? null : m));
  };

  // Wire the video element's progress/volume events (old initPlayer).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      setCur(v.currentTime);
      if (!scrubbing && v.duration) setSeekPos(((v.currentTime / v.duration) * 1000) | 0);
    };
    const onMeta = () => setDur(v.duration || 0);
    const onVol = () => {
      setMuted(v.muted || !v.volume);
      setVolume(Math.round((v.muted ? 0 : v.volume) * 100));
    };
    const onRate = () => setRate(v.playbackRate);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("volumechange", onVol);
    v.addEventListener("ratechange", onRate);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("volumechange", onVol);
      v.removeEventListener("ratechange", onRate);
    };
  }, [videoRef, scrubbing]);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const skip = (s: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.min(Math.max(0, v.currentTime + s), v.duration || 1e9);
  };
  const shownVol = muted ? 0 : volume;
  const VolIcon = shownVol === 0 ? VolumeX : shownVol < 50 ? Volume1 : Volume2;
  const commitSeek = () => {
    const v = videoRef.current;
    if (v && v.duration) v.currentTime = (v.duration * seekPos) / 1000;
    setScrubbing(false);
  };

  return (
    <>
      {/* centre play/pause — visible while paused (stage `.paused` CSS) */}
      <div id="pcCenter" className="pc-center pointer-events-none absolute inset-0 z-[3] grid place-items-center">
        <button
          id="pcBig"
          type="button"
          className="pc-big pointer-events-auto grid h-[74px] w-[74px] cursor-pointer place-items-center rounded-full border border-white/25 bg-black/55 text-white backdrop-blur-sm hover:bg-black/80"
          onClick={onToggle}
          aria-label={paused ? "Play" : "Pause"}
        >
          {paused ? <Play className="ml-1 h-9 w-9" fill="currentColor" /> : <Pause className="h-9 w-9" fill="currentColor" />}
        </button>
      </div>

      {/* bottom: full-width seek bar over one row of controls */}
      <div
        id="pcBar"
        className="pc-bar absolute inset-x-0 bottom-0 z-[4] flex flex-col bg-gradient-to-t from-black/80 to-transparent px-4 pb-1 pt-9"
      >
        <input
          id="pcSeek"
          className="pc-seek w-full"
          type="range"
          min={0}
          max={1000}
          step={1}
          value={seekPos}
          aria-label="Seek"
          style={{ ["--pc-fill" as string]: `${seekPos / 10}%` }}
          onChange={(e) => {
            setScrubbing(true);
            setSeekPos(Number(e.target.value));
          }}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
        />
        <div className="flex h-12 items-center">
          <PcIcon label="Back 10 seconds" onClick={() => skip(-10)}>
            <Skip10 back />
          </PcIcon>
          <PcIcon id="pcPlay" label={paused ? "Play (k)" : "Pause (k)"} onClick={onToggle}>
            {paused ? <Play className="h-[26px] w-[26px]" fill="currentColor" /> : <Pause className="h-[26px] w-[26px]" fill="currentColor" />}
          </PcIcon>
          <PcIcon label="Forward 10 seconds" onClick={() => skip(10)}>
            <Skip10 />
          </PcIcon>
          {/* volume: a horizontal slider slides out on hover (Crunchyroll) */}
          <div className="pc-vol flex items-center" id="pcVolWrap">
            <PcIcon
              id="pcMute"
              label={muted ? "Unmute" : "Mute"}
              onClick={() => {
                const v = videoRef.current;
                if (v) v.muted = !v.muted;
              }}
            >
              <VolIcon className="h-[26px] w-[26px]" />
            </PcIcon>
            <input
              id="pcVol"
              className="pc-vol-slider"
              type="range"
              min={0}
              max={100}
              value={shownVol}
              aria-label="Volume"
              style={{ ["--pc-fill" as string]: `${shownVol}%` }}
              onChange={(e) => {
                const val = Number(e.target.value) / 100;
                const v = videoRef.current;
                if (!v) return;
                v.muted = val === 0;
                v.volume = val;
              }}
            />
          </div>
          <span id="pcCur" className="pc-time ml-2.5 whitespace-nowrap text-[13px] font-semibold">
            {fmtTime(scrubbing && dur ? (dur * seekPos) / 1000 : cur)} / {fmtTime(dur)}
          </span>
          <span id="pcDur" className="hidden">
            {fmtTime(dur)}
          </span>

          <div className="flex-1" />

          {cc.tracks.length > 0 && (
            <PcIcon
              id="pcCc"
              label="Subtitles"
              on={cc.active >= 0 || open === "cc"}
              onClick={(e) => {
                e.stopPropagation();
                toggleMenu("cc");
              }}
            >
              <Captions className="h-[26px] w-[26px]" />
            </PcIcon>
          )}
          <button
            id="pcRate"
            type="button"
            title="Playback speed"
            className={cn("pc-btn pc-rate h-11 min-w-11 px-1.5 text-[15px] font-bold", open === "speed" && "on")}
            onClick={(e) => {
              e.stopPropagation();
              toggleMenu("speed");
            }}
          >
            {rateLabel(rate)}
          </button>
          <PcIcon
            label="Settings"
            on={open === "settings"}
            onClick={(e) => {
              e.stopPropagation();
              toggleMenu("settings");
            }}
          >
            <Settings className="h-[26px] w-[26px]" />
          </PcIcon>
          <PcIcon id="pcFs" label={isFs ? "Exit fullscreen (f)" : "Fullscreen (f)"} onClick={onFullscreen}>
            {isFs ? <Minimize className="h-[26px] w-[26px]" /> : <Maximize className="h-[26px] w-[26px]" />}
          </PcIcon>
        </div>
      </div>

      {/* menus (caption list de-duped per language by the parent) */}
      <div
        id="ccMenu"
        className={cn(
          "cc-menu absolute bottom-[76px] right-4 z-[6] w-[240px] rounded-[10px] border border-border bg-popover/95 p-1.5 shadow-2xl",
          !open && "hidden",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {open === "cc" && (
          <>
            <div className="cc-head px-2.5 pb-1.5 pt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Subtitles
            </div>
            <MenuItem on={cc.active < 0} onClick={() => onCcSelect(-1)}>
              Off
            </MenuItem>
            {cc.tracks.map((t, i) => (
              <MenuItem key={`${t.lang}-${i}`} on={cc.active === i} onClick={() => onCcSelect(i)}>
                {ccName(t.lang)}
              </MenuItem>
            ))}
          </>
        )}
        {open === "speed" && (
          <>
            <div className="cc-head px-2.5 pb-1.5 pt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Playback speed
            </div>
            {RATES.map((r) => (
              <MenuItem
                key={r}
                on={rate === r}
                onClick={() => {
                  const v = videoRef.current;
                  if (v) v.playbackRate = r;
                  setMenu(null);
                }}
              >
                {r === 1 ? "Normal" : rateLabel(r)}
              </MenuItem>
            ))}
          </>
        )}
        {open === "settings" && (
          <>
            <div className="cc-head px-2.5 pb-1.5 pt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Settings
            </div>
            <button type="button" className="cc-item flex items-center" onClick={() => onAutoplay(!autoplay)}>
              <span className="flex-1">Autoplay</span>
              <span
                className={cn(
                  "flex h-5 w-[34px] items-center rounded-full p-[3px] transition-colors",
                  autoplay ? "justify-end bg-primary" : "justify-start bg-muted",
                )}
              >
                <span className="h-3.5 w-3.5 rounded-full bg-white" />
              </span>
            </button>
          </>
        )}
      </div>
    </>
  );
}

function MenuItem({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={cn("cc-item flex items-center", on && "on")} onClick={onClick}>
      <span className="flex-1">{children}</span>
      {on && <Check className="h-[18px] w-[18px]" />}
    </button>
  );
}
