"use client";

// Users pane (staff) — user list with role chips + connection state, deny/allow
// downloads, role changes (owner), delete; invite create/copy + active-invite
// revoke; direct add-user. Ports app.js loadUsers/inviteBtn/addUserBtn +
// index.html users pane. Permission model mirrors the backend:
//   owner: anyone but self/owner · manager: only plain users.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Trash2 } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";

import { UserAvatar } from "@/components/shell/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TvSelect } from "@/components/ui/tv-select";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { useAutofillGuard, useMaskedInput } from "@/lib/autofill";
import type { InviteCreated, InvitePublic, PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";

import { copyText, errMsg, Field, PaneSection, RoleBadge } from "@/components/settings/shared";

const rank: Record<string, number> = { owner: 0, manager: 1, user: 2 };

function MiniChip({ on, off, children }: { on?: boolean; off?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-px text-[10px] leading-4",
        off
          ? "border-red-500/30 bg-red-500/10 text-red-400"
          : on
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
            : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function UsersPane() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const iAmOwner = me?.role === "owner";
  const staff = iAmOwner || me?.role === "manager";

  const usersQ = useQuery({
    queryKey: ["users"],
    queryFn: () => api<PublicUser[]>("/users"),
    enabled: !!staff,
  });
  const invitesQ = useQuery({
    queryKey: ["invites"],
    queryFn: () => api<InvitePublic[]>("/invites"),
    enabled: !!staff,
  });

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("user");
  const [inviteResult, setInviteResult] = useState<InviteCreated | null>(null);
  const [newUserName, setNewUserName] = useState("");
  const [newUserPass, setNewUserPass] = useState("");
  const inviteGuard = useAutofillGuard();
  const nameGuard = useAutofillGuard();
  const passMask = useMaskedInput();

  if (!staff) return null; // non-staff never see this (nav already hides it)

  const users = [...(usersQ.data ?? [])].sort(
    (a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3) || a.username.localeCompare(b.username),
  );

  const refreshUsers = () => void qc.invalidateQueries({ queryKey: ["users"] });

  const toggleDownloads = async (u: PublicUser) => {
    try {
      await api(`/users/${u.id}/downloads`, {
        method: "POST",
        body: JSON.stringify({ denied: !u.downloadsDenied }),
      });
      toast(u.downloadsDenied ? `${u.username} can download` : `${u.username} blocked from downloads`);
      refreshUsers();
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const changeRole = async (u: PublicUser, role: string) => {
    try {
      await api(`/users/${u.id}/role`, { method: "POST", body: JSON.stringify({ role }) });
      toast(`${u.username} → ${role}`);
    } catch (e) {
      toast(errMsg(e));
    }
    refreshUsers();
  };

  const removeUser = async (u: PublicUser) => {
    if (!window.confirm(`Remove user "${u.username}"? Their library and lists are deleted.`)) return;
    try {
      await api(`/users/${u.id}`, { method: "DELETE" });
      toast("User removed");
      refreshUsers();
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const createInvite = async () => {
    try {
      const r = await api<InviteCreated>("/invites", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      setInviteResult(r);
      toast(r.emailed ? `Invite emailed to ${inviteEmail.trim()}` : "Invite link created — copy it below");
      setInviteEmail("");
      void qc.invalidateQueries({ queryKey: ["invites"] });
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const revokeInvite = async (token: string) => {
    try {
      await api(`/invites/${token}`, { method: "DELETE" });
      toast("Invite revoked");
      if (inviteResult?.token === token) setInviteResult(null);
      void qc.invalidateQueries({ queryKey: ["invites"] });
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const addUser = async () => {
    try {
      await api("/users", {
        method: "POST",
        body: JSON.stringify({ username: newUserName.trim(), password: newUserPass }),
      });
      setNewUserName("");
      setNewUserPass("");
      toast("User added");
      refreshUsers();
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const invites = invitesQ.data ?? [];

  return (
    <div className="grid grid-cols-1 gap-4">
      <PaneSection
        title={
          <span className="flex items-center gap-2">
            Users
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {usersQ.data ? `${users.length} ${users.length === 1 ? "account" : "accounts"}` : "—"}
            </span>
          </span>
        }
        sub={
          <>
            Everyone has their own library, lists, and Real-Debrid connection. <b>Owner</b> manages
            everything; <b>Managers</b> can invite/remove users.
          </>
        }
      >
        <div className="grid grid-cols-1 gap-2">
          {users.map((u) => {
            const isMe = u.id === me?.id;
            const canManage = !isMe && u.role !== "owner" && (iAmOwner || u.role === "user");
            return (
              <div
                key={u.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5"
              >
                {/* base64 avatar when set (GET /api/users includes it), else
                    the same initials circle treatment as the topbar */}
                <UserAvatar user={u} className="h-9 w-9 text-sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{u.username}</span>
                    <RoleBadge role={u.role} />
                    {isMe && (
                      <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                        You
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {u.email ? <MiniChip>{u.email}</MiniChip> : null}
                    <MiniChip on={u.realDebridConnected}>RD</MiniChip>
                    <MiniChip on={u.allDebridConnected}>AD</MiniChip>
                    <MiniChip on={u.anilistConnected}>AniList</MiniChip>
                    <MiniChip on={u.malConnected}>MAL</MiniChip>
                    {u.downloadsDenied ? <MiniChip off>Downloads off</MiniChip> : null}
                  </div>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    title={
                      u.downloadsDenied
                        ? "Allow this user to download"
                        : "Block this user from downloading (streaming stays on)"
                    }
                    onClick={() => void toggleDownloads(u)}
                  >
                    {u.downloadsDenied ? "Allow DL" : "Deny DL"}
                  </Button>
                )}
                {iAmOwner && !isMe && u.role !== "owner" && (
                  <TvSelect
                    value={u.role}
                    onValueChange={(v) => void changeRole(u, v)}
                    className="h-8 w-28 shrink-0 text-xs"
                    aria-label={`Role for ${u.username}`}
                    options={[
                      { value: "user", label: "User" },
                      { value: "manager", label: "Manager" },
                    ]}
                  />
                )}
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                    title={`Remove ${u.username}`}
                    onClick={() => void removeUser(u)}
                  >
                    {/* Trash2 = Shiori's delete action icon (user-manager.tsx). */}
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            );
          })}
          {usersQ.isLoading && <div className="text-sm text-muted-foreground">Loading users…</div>}
        </div>
      </PaneSection>

      <PaneSection
        title="Invite a user"
        sub="Sends an invite link — they set their own password. Add an email to deliver it automatically (needs SMTP), or copy the link."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label={<>Email <span className="font-normal text-muted-foreground">(optional)</span></>} htmlFor="inviteEmail" className="flex-1">
            <Input
              id="inviteEmail"
              type="email"
              inputMode="email"
              {...inviteGuard}
              placeholder="friend@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </Field>
          <Field label="Role" className="w-full sm:w-40">
            <TvSelect
              value={inviteRole}
              onValueChange={setInviteRole}
              options={[
                { value: "user", label: "User" },
                ...(iAmOwner ? [{ value: "manager", label: "Manager" }] : []),
              ]}
            />
          </Field>
          <Button className="shrink-0" onClick={() => void createInvite()}>
            Create invite
          </Button>
        </div>

        {inviteResult && (
          <div className="flex flex-wrap gap-2">
            <Input readOnly className="w-full flex-1 font-mono text-xs sm:w-auto" value={inviteResult.url} />
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => copyText(inviteResult.url, "Link copied")}
            >
              Copy
            </Button>
          </div>
        )}

        {invites.length > 0 && (
          <div className="grid grid-cols-1 gap-2">
            <h3 className="text-sm font-semibold">Pending invites</h3>
            {invites.map((inv) => (
              <div
                key={inv.token}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2"
              >
                <RoleBadge role={inv.role} />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {inv.email || inv.username || "Anyone with the link"} · expires{" "}
                  {new Date(inv.expiresAt).toLocaleDateString()}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => copyText(inv.url, "Link copied")}
                >
                  <Copy className="mr-1 h-3.5 w-3.5" /> Copy
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                  onClick={() => void revokeInvite(inv.token)}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}

        <details className="rounded-lg border border-border bg-background/40 px-3 py-2">
          <summary className="cursor-pointer select-none text-sm text-muted-foreground">
            Add a user directly (set their password)
          </summary>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Username" htmlFor="newUserName" className="flex-1">
              <Input
                id="newUserName"
                {...nameGuard}
                placeholder="username"
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
              />
            </Field>
            <Field label="Password" htmlFor="newUserPass" className="flex-1">
              <Input
                id="newUserPass"
                {...passMask}
                className={cn(passMask.className)}
                placeholder="min 8 chars"
                value={newUserPass}
                onChange={(e) => setNewUserPass(e.target.value)}
              />
            </Field>
            <Button variant="outline" className="shrink-0" onClick={() => void addUser()}>
              Add user
            </Button>
          </div>
        </details>
      </PaneSection>
    </div>
  );
}
