"use client";

// ---------------------------------------------------------------------------
// Library chips — port of renderFolderChips / renderChips (public/app.js:728).
//   * Folder row: "📁 All" + one chip per folder (with count) + "+ New folder".
//     The old app used prompt(); native WebViews don't reliably implement
//     onJsPrompt, so creation runs through a small dialog with the same
//     validation (trim, non-empty) — the server rejects the rest, surfaced as
//     a toast, exactly like the old error path. On success the new folder
//     becomes active and "Folder created" toasts.
//   * List row: All + [watchlist, favorites, …custom lists] with counts.
// ---------------------------------------------------------------------------

import React, { useState } from "react";
import { toast } from "sonner";

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
import { api } from "@/lib/api";
import type { FolderInfo, ListCounts } from "@/lib/types";
import { cn } from "@/lib/utils";

function Chip({
  active,
  activeClass,
  className,
  children,
  onClick,
}: {
  active?: boolean;
  /** Gradient for the active state (folder chips use the indigo one). */
  activeClass?: string;
  className?: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // NOTE: not the literal `chip` class — globals.css already has an
        // unlayered Shiori `.chip` rule that would override these utilities.
        "r-chip rounded-full border px-3.5 py-1.5 text-[13px] transition-colors",
        active
          ? (activeClass ?? "border-transparent bg-primary text-primary-foreground")
          : "border-border bg-card text-muted-foreground hover:border-ring hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

interface FolderChipsProps {
  folders: FolderInfo[] | undefined;
  activeFolder: string;
  onSelect: (folder: string) => void;
  /** Called with the created folder's name after POST /folders succeeds. */
  onCreated: (name: string) => void;
}

export function FolderChips({ folders, activeFolder, onSelect, onCreated }: FolderChipsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return; // old code: empty prompt result -> no-op
    setSaving(true);
    try {
      await api("/folders", { method: "POST", body: JSON.stringify({ name: trimmed }) });
      setDialogOpen(false);
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
    <div className="chips folders-row mt-3.5 flex flex-wrap gap-2">
      <Chip
        active={activeFolder === ""}
        activeClass="folder-chip border-transparent bg-gradient-to-br from-indigo-500 to-indigo-400 text-white"
        className="folder-chip"
        onClick={() => onSelect("")}
      >
        📁 All
      </Chip>
      {(folders || []).map((f) => (
        <Chip
          key={f.name}
          active={activeFolder === f.name}
          activeClass="folder-chip border-transparent bg-gradient-to-br from-indigo-500 to-indigo-400 text-white"
          className="folder-chip"
          onClick={() => onSelect(f.name)}
        >
          {f.name}
          {f.count ? <span className="cnt ml-1.5 opacity-60">{f.count}</span> : null}
        </Chip>
      ))}
      <Chip className="new-chip border-dashed" onClick={() => setDialogOpen(true)}>
        + New folder
      </Chip>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        {/* literal `modal` class: tvnav treats an open dialog as the blocking
            overlay and scopes D-pad focus to it */}
        <DialogContent className="modal w-[95vw] max-w-lg sm:w-full">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Folders group your library — a title lives in exactly one.
            </DialogDescription>
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
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ListChipsProps {
  counts: ListCounts | undefined;
  activeList: string;
  onSelect: (list: string) => void;
}

export function ListChips({ counts, activeList, onSelect }: ListChipsProps) {
  // Old renderChips: built-ins first, then any custom lists from the counts.
  const names = [...new Set(["watchlist", "favorites", ...Object.keys(counts || {})])];
  return (
    <div className="chips mt-3.5 flex flex-wrap gap-2">
      <Chip active={activeList === ""} onClick={() => onSelect("")}>
        All
      </Chip>
      {names.map((n) => {
        const count = counts?.[n] ?? 0;
        return (
          <Chip key={n} active={activeList === n} onClick={() => onSelect(n)}>
            {n}
            {count ? <span className="ml-1.5 opacity-60">{count}</span> : null}
          </Chip>
        );
      })}
    </div>
  );
}
