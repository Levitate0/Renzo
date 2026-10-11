"use client";

// Downloads — the title page's left-rail section for where this series'
// episodes land (library folder) and which release group they come from, in
// Shiori's rail-section form. Moved here from the old hero's detail-controls
// row; the folder and provider calls are unchanged (populateFolderSelect /
// loadProviders, public/app.js:950/1025).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { TvSelect } from "@/components/ui/tv-select";
import { api } from "@/lib/api";
import type { ProviderOption, TitleDetail } from "@/lib/types";

import type { DetailModel } from "./detail-model";

const NEW_FOLDER = "__new__";

export function DownloadSettings({ d }: { d: DetailModel }) {
  const qc = useQueryClient();
  const patch = (p: Partial<TitleDetail>) =>
    qc.setQueryData<TitleDetail>(["title", d.id], (old) => (old ? { ...old, ...p } : old));

  // Guarantee a real folder is always the resting selection (never "+ New…").
  const names = [...new Set([...(d.folders || []), d.folder].filter(Boolean))];
  if (!names.length) names.push("Library");
  const folder = d.folder && names.includes(d.folder) ? d.folder : names[0]!;

  const providersQ = useQuery({
    queryKey: ["title", d.id, "providers"],
    queryFn: () => api<ProviderOption[]>(`/titles/${d.id}/providers`),
    retry: false,
    staleTime: 60_000,
  });
  const providers = providersQ.data || [];
  // A saved provider missing from the list is added so it stays selected.
  const extra =
    d.provider && !providers.some((p) => p.group.toLowerCase() === d.provider!.toLowerCase()) ? d.provider : null;

  const moveFolder = async (next: string) => {
    if (next === NEW_FOLDER) {
      next = (window.prompt("New folder name") || "").trim();
      if (!next) return; // controlled select snaps back
    }
    try {
      const r = await api<{ folder: string }>(`/titles/${d.id}/folder`, {
        method: "POST",
        body: JSON.stringify({ folder: next }),
      });
      const folders = (d.folders || []).includes(r.folder) ? d.folders : [...(d.folders || []), r.folder];
      patch({ folder: r.folder, folders });
      void qc.invalidateQueries({ queryKey: ["library"] });
      toast(`Moved to “${r.folder}”`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const setProvider = async (group: string) => {
    try {
      const r = await api<{ provider: string | null }>(`/titles/${d.id}/provider`, {
        method: "POST",
        body: JSON.stringify({ group }),
      });
      patch({ provider: r.provider });
      toast(r.provider ? `Provider set: ${r.provider}` : "Provider: Auto (best)");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-foreground">Downloads</h2>
      <div className="space-y-2">
        <Label>Library folder</Label>
        <TvSelect
          aria-label="Library folder"
          value={folder}
          onValueChange={(v) => void moveFolder(v)}
          options={[...names.map((n) => ({ value: n, label: n })), { value: NEW_FOLDER, label: "+ New folder…" }]}
          className="w-full"
        />
      </div>
      <div className="space-y-2">
        <Label>Release group</Label>
        <TvSelect
          aria-label="Preferred release group"
          // "" is the web's Auto (best); Radix Select can't hold "", so a sentinel.
          value={d.provider || "__auto__"}
          onValueChange={(v) => void setProvider(v === "__auto__" ? "" : v)}
          options={[
            { value: "__auto__", label: "Auto (best)" },
            ...(providersQ.isLoading ? [{ value: "__loading__", label: "loading…", disabled: true }] : []),
            ...providers.map((p) => {
              const res = [...(p.resolutions || [])].sort((a, b) => b - a)[0];
              return { value: p.group, label: `${p.group}${res ? ` · ${res}p` : ""} (${p.count})` };
            }),
            ...(extra ? [{ value: extra, label: extra }] : []),
          ]}
          className="w-full"
        />
        <p className="text-xs text-muted-foreground">Used for every episode and season of this series.</p>
      </div>
    </section>
  );
}
