"use client";

// /watch/?id=<watchId>&ep=<n> — the player (old #/watch/<id>/<ep> hash route).
// useSearchParams requires a Suspense boundary under static export.

import React, { Suspense } from "react";

import { WatchView } from "@/components/player/watch-view";

export default function WatchPage() {
  return (
    <Suspense fallback={null}>
      <WatchView />
    </Suspense>
  );
}
