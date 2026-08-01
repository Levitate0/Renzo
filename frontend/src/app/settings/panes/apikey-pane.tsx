"use client";

// API key pane — per-user API key (masked display, show/hide, copy,
// regenerate) + the Jellyfin plugin repository URL and install steps. Ports
// the old (hidden) "Jellyfin" pane: index.html:474 + app.js loadApiKey/
// apiKeyReveal/apiKeyCopy/apiKeyRotate. Loads lazily — the query only runs
// while this pane is mounted (old: first click on the nav button).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { MASKED_CLASS } from "@/lib/autofill";
import type { ApiKeyInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

import { copyText, errMsg, Field, PaneSection } from "../shared";

export function ApiKeyPane() {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);

  const q = useQuery({
    queryKey: ["apikey"],
    queryFn: () => api<ApiKeyInfo>("/account/apikey"),
    staleTime: Infinity,
  });
  const apiKey = q.data?.apiKey ?? "";
  const manifest = q.data?.manifestUrl ?? "";

  const rotate = async () => {
    if (
      !window.confirm(
        "Regenerate your API key? Anything using the old key (e.g. Jellyfin) will stop working until you paste the new one.",
      )
    )
      return;
    try {
      const r = await api<{ apiKey: string }>("/account/apikey/rotate", { method: "POST" });
      qc.setQueryData<ApiKeyInfo>(["apikey"], (old) =>
        old ? { ...old, apiKey: r.apiKey } : old,
      );
      toast("New API key generated — update it in Jellyfin");
    } catch (e) {
      toast(errMsg(e));
    }
  };

  return (
    <PaneSection
      title="API key"
      sub={
        <>
          Watch your Renzo library inside Jellyfin. Your <b>personal API key</b> links the Renzo
          plugin to <i>your</i> account — playback streams through your own Real-Debrid and your own
          library, never anyone else&apos;s.
        </>
      }
    >
      <Field
        label="Your API key"
        htmlFor="apiKey"
        hint={
          <>
            Keep this secret — anyone with it can stream through your Real-Debrid.{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => void rotate()}
            >
              Regenerate
            </button>{" "}
            if it leaks (updates needed anywhere you used it).
          </>
        }
      >
        <div className="flex flex-wrap gap-2">
          <Input
            id="apiKey"
            readOnly
            className={cn("w-full flex-1 font-mono text-xs sm:w-auto", !show && MASKED_CLASS)}
            value={apiKey}
            placeholder={q.isLoading ? "Loading…" : ""}
          />
          <Button variant="outline" className="shrink-0" onClick={() => setShow((s) => !s)}>
            {show ? "Hide" : "Show"}
          </Button>
          <Button className="shrink-0" onClick={() => copyText(apiKey, "API key copied")}>
            Copy
          </Button>
        </div>
      </Field>

      <Field label="Plugin repository URL" htmlFor="jfManifest">
        <div className="flex flex-wrap gap-2">
          <Input
            id="jfManifest"
            readOnly
            className="w-full flex-1 font-mono text-xs sm:w-auto"
            value={manifest}
          />
          <Button
            className="shrink-0"
            onClick={() => copyText(manifest, "Repository URL copied")}
          >
            Copy
          </Button>
        </div>
      </Field>

      <details className="rounded-lg border border-border bg-background/40 px-3 py-2" open>
        <summary className="cursor-pointer select-none text-sm text-muted-foreground">
          How to install
        </summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li>
            In Jellyfin: <b>Dashboard → Plugins → Repositories → ＋</b>, paste the repository URL
            above, save.
          </li>
          <li>
            <b>Catalog</b> → install <b>Renzo</b> → restart Jellyfin.
          </li>
          <li>
            <b>Dashboard → Plugins → Renzo</b> → set the Renzo server URL and paste <b>your API
            key</b> from above.
          </li>
          <li>
            Open the <b>Renzo</b> channel (Trending · This Season · Recommended); titles you browse
            become searchable in Jellyfin.
          </li>
        </ol>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Note: Jellyfin 10.11 has no live channel search, so Renzo titles show up in Jellyfin&apos;s
          global search after the channel has been browsed or refreshed — not typed live against
          Renzo.
        </p>
      </details>
    </PaneSection>
  );
}
