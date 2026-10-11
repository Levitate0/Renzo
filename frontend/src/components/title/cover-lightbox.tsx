"use client";

// Copied from Shiori (RenzoFrontend components/comp/series/cover-lightbox.tsx)
// — keep in step. Hub twin: TitleScreen.kt TitleHero's cover Dialog.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Full-screen cover viewer: click a series cover to expand it. Click anywhere
 * (or press Escape) to close.
 *
 * Rendered through a portal onto document.body — REQUIRED, not decoration: the
 * Browse "about" dialog positions itself with a CSS transform, which makes it
 * the containing block for fixed-position children. Without the portal the
 * lightbox renders trapped inside (and clipped by) the dialog box.
 *
 * The image is scaled UP to ~88% of the viewport height (covers are small
 * thumbnails; plain max-h/max-w would show them tiny at natural size).
 */
export function CoverLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    // Capture phase + stopPropagation so Escape dismisses the lightbox FIRST and
    // doesn't also bubble to a parent Radix dialog (which would otherwise close
    // the whole "about" panel behind the cover). Exiting expanded mode should
    // return to the dialog, not tear it down too.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      // pointer-events-auto is REQUIRED, not cosmetic: when the lightbox is
      // opened from a Radix modal dialog (the Browse "about" panel), Radix sets
      // `pointer-events: none` on <body> while the dialog is open. This portal is
      // a direct child of <body> and inherits it, so without forcing pointer
      // events back on, the backdrop and close button become unclickable and the
      // expanded cover can't be dismissed.
      style={{ pointerEvents: "auto" }}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={`${alt} — expanded cover`}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
        className="absolute right-4 top-4 z-10 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="h-[88vh] w-auto max-w-[94vw] rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}
