"use client";

// /users/ — users + invites pane as its own route, staff only (owner+manager;
// old usersNavBtn gating). Mirrors Shiori's /users page, which is admin-gated
// by hiding the menu link; deep-linkers get the friendly NotAuthorized card.

import React from "react";

import { NotAuthorized } from "@/components/settings/not-authorized";
import { SettingsRouteShell } from "@/components/settings/route-shell";
import { AppShell } from "@/components/shell/app-shell";
import { useAuth } from "@/contexts/auth-context";

import { UsersPane } from "./users-pane";

export default function UsersPage() {
  const { user } = useAuth();
  const isStaff = user?.role === "owner" || user?.role === "manager";

  return (
    <AppShell>
      <SettingsRouteShell
        title="Users"
        description="Manage user accounts, invite new users, and control downloads."
      >
        {isStaff ? <UsersPane /> : <NotAuthorized needs="managers and the owner" />}
      </SettingsRouteShell>
    </AppShell>
  );
}
