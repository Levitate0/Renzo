"use client";

// Auto-next countdown card — old #autoNext / startAutoNext (app.js:1533-1554).
// Parent owns WHEN it shows (video ended, more episodes left); this component
// owns the 8-second countdown and fires onPlay when it reaches zero.

import React, { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

export interface AutoNextInfo {
  ep: number;
  title: string;
  thumb: string;
}

export function AutoNextCard({
  info,
  onPlay,
  onCancel,
}: {
  info: AutoNextInfo;
  onPlay: () => void;
  onCancel: () => void;
}) {
  const [n, setN] = useState(8);
  const fired = useRef(false); // fire onPlay exactly once per proposal

  // Restart the countdown whenever a new episode is proposed.
  useEffect(() => {
    setN(8);
    fired.current = false;
    const iv = setInterval(() => setN((v) => v - 1), 1000);
    return () => clearInterval(iv);
  }, [info.ep]);

  useEffect(() => {
    if (n <= 0 && !fired.current) {
      fired.current = true;
      onPlay();
    }
  }, [n, onPlay]);

  return (
    <div className="autonext absolute bottom-[74px] right-4 z-[4] flex w-[340px] max-w-[70vw] gap-3 rounded-xl border border-border bg-background/95 p-3 shadow-2xl backdrop-blur-md">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="an-thumb h-[60px] w-[104px] flex-none rounded-lg bg-muted object-cover"
        src={info.thumb}
        alt=""
      />
      <div className="an-body flex min-w-0 flex-col gap-0.5">
        <div className="an-label text-[11px] uppercase tracking-wider text-muted-foreground">
          Up next
        </div>
        <div className="an-title truncate font-semibold">{info.title}</div>
        <div className="an-count text-xs text-muted-foreground">
          Next episode in {Math.max(0, n)}s
        </div>
        <div className="an-actions mt-1.5 flex gap-2">
          <Button size="sm" className="h-7 px-2.5 text-[13px]" onClick={onPlay}>
            ▶ Play now
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[13px]"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
