"use client";

// Library ribbon — Shiori's library ribbon (RenzoFrontend app/library/page.tsx
// <RibbonSlot>), portaled into the command bar: compact h-8 selects for folder
// and list and the 18+ button on the left; sort, card size, New folder and the
// primary Import action pushed right (ml-auto). Replaces the folder/list chip
// rows and the "My Library" head (branch backup/pre-shiori-restyle).

import { FolderPlus, RefreshCw } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";

import { RibbonSlot } from "@/components/shell/ribbon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TvSelect } from "@/components/ui/tv-select";
import { api } from "@/lib/api";
import type { FolderInfo, ListCounts } from "@/lib/types";

import { CARD_SIZES, setCardSize, useCardSize } from "./card-size";
import { AdultToggle } from "./content-filter";

const TRIGGER = "h-8 w-full !pr-2 text-xs sm:text-sm";
const ALL = "__all__"; // Radix Select can't hold "" as a value

const listLabel = (n: string) => (n === "watchlist" ? "Watchlist" : n === "favorites" ? "Favourites" : n);

export function LibraryRibbon({
  folders,
  activeFolder,
  onFolder,
  counts,
  activeList,
  onList,
  orderBy,
  onOrderBy,
  importing,
  onImport,
  onFolderCreated,
}: {
  folders: FolderInfo[] | undefined;
  activeFolder: string;
  onFolder: (f: string) => void;
  counts: ListCounts | undefined;
  activeList: string;
  onList: (l: string) => void;
  orderBy: string;
  onOrderBy: (o: string) => void;
  importing: boolean;
  onImport: () => void;
  onFolderCreated: (name: string) => void;
}) {
  const size = useCardSize();
  const [newOpen, setNewOpen] = useState(false);
  // Built-ins first, then any custom lists (old renderChips).
  const names = [...new Set(["watchlist", "favorites", ...Object.keys(counts || {})])];

  return (
    <RibbonSlot>
      <div className="flex w-full items-center gap-2">
        <div className="w-36 shrink-0 sm:w-44">
          <TvSelect
            aria-label="Folder"
            className={TRIGGER}
            value={activeFolder || ALL}
            onValueChange={(v) => onFolder(v === ALL ? "" : v)}
            options={[
              { value: ALL, label: "All folders" },
              ...(folders || []).map((f) => ({ value: f.name, label: f.count ? `${f.name} (${f.count})` : f.name })),
            ]}
          />
        </div>
        <div className="w-32 shrink-0 sm:w-40">
          <TvSelect
            aria-label="List"
            className={TRIGGER}
            value={activeList || ALL}
            onValueChange={(v) => onList(v === ALL ? "" : v)}
            options={[
              { value: ALL, label: "All lists" },
              ...names.map((n) => ({ value: n, label: `${listLabel(n)}${counts?.[n] ? ` (${counts[n]})` : ""}` })),
            ]}
          />
        </div>
        {/* 18+ — Shiori's button, in Shiori's place. */}
        <AdultToggle />

        {/* Right cluster: sort, card size, New folder, Import */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div className="w-32 sm:w-36">
            <TvSelect
              aria-label="Sort"
              className={TRIGGER}
              value={orderBy}
              onValueChange={onOrderBy}
              options={[
                { value: "library", label: "Recently added" },
                { value: "title", label: "Alphabetical" },
              ]}
            />
          </div>
          <div className="w-14 sm:w-16">
            <TvSelect
              aria-label="Card size"
              className={TRIGGER}
              value={size.value}
              onValueChange={setCardSize}
              options={CARD_SIZES.map((s) => ({ value: s.value, label: s.label }))}
            />
          </div>
          <button
            type="button"
            onClick={() => setNewOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/40 bg-foreground/[0.04] px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New folder</span>
          </button>
          <Button id="importBtn" size="sm" className="h-8 gap-1.5 px-3 text-xs" disabled={importing} onClick={onImport}>
            <RefreshCw className={importing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            <span className="hidden sm:inline">{importing ? "Importing…" : "Import AniList / MAL"}</span>
          </Button>
        </div>
      </div>

      <NewFolderDialog open={newOpen} onOpenChange={setNewOpen} onCreated={onFolderCreated} />
    </RibbonSlot>
  );
}

function NewFolderDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return; // old code: empty prompt result -> no-op
    setSaving(true);
    try {
      await api("/folders", { method: "POST", body: JSON.stringify({ name: trimmed }) });
      onOpenChange(false);
      setName("");
      onCreated(trimmed);
      toast("Folder created");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Folder create failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* literal `modal` class: tvnav treats an open dialog as the blocking
          overlay and scopes D-pad focus to it */}
      <DialogContent className="modal w-[95vw] max-w-lg sm:w-full">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>Folders group your library — a title lives in exactly one.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Folder name"
            enterKeyHint="done"
            autoComplete="off"
            data-1p-ignore=""
            data-lpignore="true"
            data-form-type="other"
          />
          <DialogFooter className="mt-4 gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
