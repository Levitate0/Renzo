"use client";

// Library defaults pane — per-user "on add" defaults (tracking status,
// auto-download, folder), auto-update-tracking (autoStatus), preferred
// subtitle language (ccLang) and the native offline download folder. Ports
// index.html defaults pane + app.js loadDefaults/defSave/initDownloadFolderUI.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TvSelect } from "@/components/ui/tv-select";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { chooseDownloadFolder, getDownloadFolder, nativeStore } from "@/lib/offline";
import type { FolderInfo, PublicUser } from "@/lib/types";

import { errMsg, Field, PaneSection } from "../shared";

const NONE = "__none__"; // Radix Select forbids empty item values

// Old #defTrack options.
const TRACK_OPTIONS: [string, string][] = [
  [NONE, "— Don't set —"],
  ["watching", "Watching"],
  ["planning", "Plan to watch"],
  ["completed", "Completed"],
  ["paused", "Paused"],
  ["dropped", "Dropped"],
  ["rewatching", "Rewatching"],
];

// Old #defCc options (index.html:438).
const CC_LANGS: [string, string][] = [
  ["off", "Off"],
  ["en", "English"],
  ["ja", "Japanese"],
  ["es", "Spanish"],
  ["es-la", "Spanish (Latin America)"],
  ["pt-br", "Portuguese (Brazil)"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["ru", "Russian"],
  ["ar", "Arabic"],
  ["zh", "Chinese"],
  ["ko", "Korean"],
];

export function DefaultsPane() {
  const { user, updateUser } = useAuth();
  const qc = useQueryClient();

  const [track, setTrack] = useState(NONE);
  const [autoStatus, setAutoStatus] = useState<"on" | "off">("on");
  const [cc, setCc] = useState("en");
  const [folder, setFolder] = useState(NONE);
  const [autoDl, setAutoDl] = useState(false);

  // Seed the form once from the user record (old loadDefaults).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !user) return;
    seeded.current = true;
    const d = user.addDefaults || {};
    setTrack(d.track || NONE);
    setAutoStatus(user.autoStatus === false ? "off" : "on");
    setCc(user.ccLang || "en");
    setFolder(d.folder || NONE);
    setAutoDl(!!d.autoDownload);
  }, [user]);

  const foldersQ = useQuery({
    queryKey: ["folders"],
    queryFn: () => api<FolderInfo[]>("/folders"),
    enabled: !!user,
  });
  const folders = foldersQ.data ?? [];
  // Keep a stale saved folder selectable even if it's not in the list anymore.
  const folderNames = folders.map((f) => f.name);
  if (folder !== NONE && !folderNames.includes(folder)) folderNames.push(folder);

  // Offline download folder (native shells only, old initDownloadFolderUI).
  const [showDlRow, setShowDlRow] = useState(false);
  const [dlFolder, setDlFolder] = useState("");
  useEffect(() => {
    if (!nativeStore()) return;
    setShowDlRow(true);
    void getDownloadFolder().then((f) => setDlFolder(f || ""));
  }, []);

  const pickDlFolder = async () => {
    try {
      const f = await chooseDownloadFolder();
      if (f) {
        setDlFolder(f);
        toast("Download folder set");
      }
    } catch (e) {
      toast(errMsg(e) || "Couldn't set folder");
    }
  };

  const save = async () => {
    try {
      const u = await api<PublicUser>("/account/add-defaults", {
        method: "POST",
        body: JSON.stringify({
          track: track === NONE ? "" : track,
          autoDownload: autoDl,
          folder: folder === NONE ? "" : folder,
          autoStatus: autoStatus === "on",
          ccLang: cc,
        }),
      });
      updateUser({ addDefaults: u.addDefaults, autoStatus: u.autoStatus, ccLang: u.ccLang });
      void qc.invalidateQueries({ queryKey: ["folders"] });
      toast("Library defaults saved");
    } catch (e) {
      toast(errMsg(e));
    }
  };

  return (
    <PaneSection
      title="Library defaults"
      sub="Applied automatically the first time a series enters your library — when you add it or put it on a list. Leave blank / off to do nothing."
    >
      <Field label="Set tracking status" hint="Synced to your AniList / MyAnimeList when connected.">
        <TvSelect
          value={track}
          onValueChange={setTrack}
          className="w-full sm:w-72"
          options={TRACK_OPTIONS.map(([value, label]) => ({ value, label }))}
        />
      </Field>

      <Field
        label="Auto-update tracking status"
        hint="Keeps your AniList / MyAnimeList status in sync as you watch."
      >
        <TvSelect
          value={autoStatus}
          onValueChange={(v) => setAutoStatus(v === "off" ? "off" : "on")}
          className="w-full sm:w-96"
          options={[
            { value: "on", label: "On — Watching as I watch, Completed when finished" },
            { value: "off", label: "Off — I'll set the status manually" },
          ]}
        />
      </Field>

      <Field
        label="Preferred subtitles"
        hint="Auto-selected in the player when that language is available."
      >
        <TvSelect
          value={cc}
          onValueChange={setCc}
          className="w-full sm:w-72"
          options={CC_LANGS.map(([value, label]) => ({ value, label }))}
        />
      </Field>

      <Field label="Add to folder">
        <TvSelect
          value={folder}
          onValueChange={setFolder}
          className="w-full sm:w-72"
          options={[
            { value: NONE, label: "— Default folder —" },
            ...folderNames.map((name) => ({ value: name, label: name })),
          ]}
        />
      </Field>

      {/* Auto-download opt-in — hidden entirely when downloads are denied. */}
      {!user?.downloadsDenied && (
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <Checkbox checked={autoDl} onCheckedChange={(v) => setAutoDl(v === true)} />
          <span>Auto-download new episodes to your own Real-Debrid</span>
        </label>
      )}

      {showDlRow && (
        <Field
          label="Offline download folder (this device)"
          hint={
            <>
              Where episodes you &quot;Save offline&quot; are stored on this device. Desktop/mobile
              app only.
            </>
          }
        >
          <div className="flex flex-wrap gap-2">
            <Input
              readOnly
              className="w-full flex-1 sm:w-auto"
              placeholder="Not set — you'll be asked on first save"
              value={dlFolder}
            />
            <Button className="shrink-0" onClick={() => void pickDlFolder()}>
              Choose…
            </Button>
          </div>
        </Field>
      )}

      <div>
        <Button onClick={() => void save()}>Save defaults</Button>
      </div>
    </PaneSection>
  );
}
