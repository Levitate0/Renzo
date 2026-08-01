"use client";

// /account/?section=<account|credentials|defaults|apikey>
// useSearchParams needs a Suspense boundary under static export (CONTRACTS).

import React, { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";

import { AccountView } from "./account-view";

export default function AccountPage() {
  return (
    <AppShell>
      <Suspense fallback={<div className="view active" />}>
        <AccountView />
      </Suspense>
    </AppShell>
  );
}
