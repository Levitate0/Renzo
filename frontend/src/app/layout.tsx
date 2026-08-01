"use client";

import "@/styles/globals.css";
import React from "react";

import { GeistSans } from "geist/font/sans";
import { Fraunces, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";

import { GateHost } from "@/components/gates/gate-host";
import QueryProvider from "@/components/providers/query-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/auth-context";
import { SearchProvider } from "@/contexts/search-context";

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-fraunces",
  axes: ["opsz"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${GeistSans.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <title>Renzo</title>
        <meta name="description" content="Your self-hosted anime library" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0a0a0a" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Renzo" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        {/* Renzo is dark-only (aligned with Shiori — the `dark` class above is
            static). This bootstrap only applies the named palette preset +
            custom accent before first paint, same keys/scheme as Shiori so the
            two apps' Appearance settings stay interchangeable. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var preset = localStorage.getItem('renzo-preset');
                  if (preset && preset !== 'renzo') {
                    document.documentElement.setAttribute('data-theme', preset);
                  }
                  var accent = localStorage.getItem('renzo-accent');
                  if (accent === 'custom') {
                    var hsl = (localStorage.getItem('renzo-accent-custom') || '').trim().split(/\\s+/);
                    if (hsl.length === 3) {
                      var d = document.documentElement.style;
                      d.setProperty('--primary-h', hsl[0]);
                      d.setProperty('--primary-s', hsl[1]);
                      d.setProperty('--primary-l', hsl[2]);
                      document.documentElement.setAttribute('data-accent', 'custom');
                    }
                  }
                } catch (_) {
                  // Fall back to the default rose accent.
                }
              })();
            `,
          }}
        />
        {/* TV D-pad navigation — framework-agnostic, also exposes window.RenzoTV
            for the native Android shell (MainActivity evaluates RenzoTV.enable/
            back/playPause — that contract must never break). */}
        <script src="/tvnav.js" defer />
      </head>
      <body suppressHydrationWarning>
        <TooltipProvider>
          <QueryProvider>
            <AuthProvider>
              <SearchProvider>
                {/* Auth/offline gates overlay EVERYTHING (old app's fixed
                    gates); pages render underneath inside their own AppShell. */}
                <GateHost />
                {children}
              </SearchProvider>
            </AuthProvider>
            <Toaster position="top-center" richColors />
          </QueryProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
