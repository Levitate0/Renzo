"use client";

// Custom control bar + centre play button + CC menu — old initPlayer /
// buildCcMenu (app.js:1618-1712). All controls operate directly on the <video>
// element (the parent owns src/tracks); time/seek/volume/rate state lives here.
// Literal class names (pc-bar, pc-seek, pc-vol-slider, cc-menu…) are kept for
// the appended player CSS in globals.css.

import React, { useEffect, useState } from "react";

import { ccName } from "@/components/player/captions";
import { fmtTime } from "@/components/player/season-utils";
import { cn } from "@/lib/utils";

const RATES = [1, 1.25, 1.5, 2, 0.5];

export interface CcState {
  tracks: { lang: string }[];
  active: number;
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
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  paused: boolean;
  onToggle: () => void;
  cc: CcState;
  ccMenuOpen: boolean;
  onCcMenuToggle: () => void;
  onCcSelect: (idx: number) => void;
  onFullscreen: () => void;
}) {
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [seekPos, setSeekPos] = useState(0); // 0..1000
  const [scrubbing, setScrubbing] = useState(false);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [rateIdx, setRateIdx] = useState(0);

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
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("volumechange", onVol);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("volumechange", onVol);
    };
  }, [videoRef, scrubbing]);

  const volIcon = muted ? "🔇" : volume < 50 ? "🔉" : "🔊";

  return (
    <>
      {/* centre play/pause — visible while paused (stage `.paused` CSS) */}
      <div id="pcCenter" className="pc-center pointer-events-none absolute inset-0 z-[3] grid place-items-center">
        <button
          id="pcBig"
          type="button"
          className="pc-big pointer-events-auto h-[74px] w-[74px] cursor-pointer rounded-full border border-white/25 bg-black/55 text-[26px] text-white backdrop-blur-sm hover:bg-black/80"
          onClick={onToggle}
          aria-label={paused ? "Play" : "Pause"}
        >
          {paused ? "▶" : "❚❚"}
        </button>
      </div>

      {/* bottom control bar */}
      <div id="pcBar" className="pc-bar absolute inset-x-0 bottom-0 z-[4] flex items-center gap-2.5 bg-gradient-to-t from-black/80 to-transparent px-3.5 pb-3 pt-6">
        <button
          id="pcPlay"
          type="button"
          className="pc-btn pc-pp"
          title="Play/Pause"
          onClick={onToggle}
        >
          {paused ? "▶" : "❚❚"}
        </button>
        <span id="pcCur" className="pc-time">
          {fmtTime(scrubbing && dur ? (dur * seekPos) / 1000 : cur)}
        </span>
        <input
          id="pcSeek"
          className="pc-seek"
          type="range"
          min={0}
          max={1000}
          step={1}
          value={seekPos}
          aria-label="Seek"
          onChange={(e) => {
            setScrubbing(true);
            setSeekPos(Number(e.target.value));
          }}
          onPointerUp={() => {
            const v = videoRef.current;
            if (v && v.duration) v.currentTime = (v.duration * seekPos) / 1000;
            setScrubbing(false);
          }}
          onKeyUp={() => {
            const v = videoRef.current;
            if (v && v.duration) v.currentTime = (v.duration * seekPos) / 1000;
            setScrubbing(false);
          }}
        />
        <span id="pcDur" className="pc-time">
          {fmtTime(dur)}
        </span>
        <button
          id="pcCc"
          type="button"
          className={cn("pc-btn", cc.active >= 0 && "on")}
          title="Subtitles"
          onClick={(e) => {
            e.stopPropagation();
            onCcMenuToggle();
          }}
        >
          CC
        </button>
        <button
          id="pcRate"
          type="button"
          className="pc-btn pc-rate"
          title="Speed"
          onClick={() => {
            const ri = (rateIdx + 1) % RATES.length;
            setRateIdx(ri);
            const v = videoRef.current;
            if (v) v.playbackRate = RATES[ri]!;
          }}
        >
          {RATES[rateIdx]}×
        </button>
        <div className="pc-vol relative flex items-center" id="pcVolWrap">
          <button
            id="pcMute"
            type="button"
            className="pc-btn"
            title="Mute"
            onClick={() => {
              const v = videoRef.current;
              if (v) v.muted = !v.muted;
            }}
          >
            {volIcon}
          </button>
          <input
            id="pcVol"
            className="pc-vol-slider"
            type="range"
            min={0}
            max={100}
            value={volume}
            aria-label="Volume"
            onChange={(e) => {
              const val = Number(e.target.value) / 100;
              const v = videoRef.current;
              if (!v) return;
              v.muted = val === 0;
              v.volume = val;
            }}
          />
        </div>
        <button id="pcFs" type="button" className="pc-btn" title="Fullscreen" onClick={onFullscreen}>
          ⤢
        </button>
      </div>

      {/* caption language menu (de-duped per language by the parent) */}
      <div
        id="ccMenu"
        className={cn(
          "cc-menu absolute bottom-[62px] right-3.5 z-[6] min-w-[150px] rounded-[10px] border border-border bg-popover/95 p-1.5 shadow-2xl",
          !ccMenuOpen && "hidden",
        )}
      >
        <div className="cc-head px-2.5 pb-1.5 pt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          Subtitles
        </div>
        <button
          type="button"
          className={cn("cc-item", cc.active < 0 && "on")}
          onClick={() => onCcSelect(-1)}
        >
          Off
        </button>
        {cc.tracks.map((t, i) => (
          <button
            key={`${t.lang}-${i}`}
            type="button"
            className={cn("cc-item", cc.active === i && "on")}
            onClick={() => onCcSelect(i)}
          >
            {ccName(t.lang)}
          </button>
        ))}
      </div>
    </>
  );
}
