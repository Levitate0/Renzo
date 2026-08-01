"use client";

// Friendly not-authorized state for role-gated routes (/users/ staff-only,
// /settings/ owner-only). Shiori gates by hiding the menu links entirely
// (user-menu.tsx canAdmin/canOwner) — its routes have no in-page guard — so
// this card is the Renzo equivalent for anyone who deep-links past the hidden
// entry points. Styled like a Shiori Card (rounded-xl border bg-card).

import { Lock } from "lucide-react";
import Link from "next/link";
import React from "react";

import { Button } from "@/components/ui/button";

export function NotAuthorized({ needs }: { needs: string }) {
  return (
    <div className="grid grid-cols-1 place-items-center gap-3 rounded-xl border border-border bg-card px-6 py-14 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <Lock className="h-5 w-5" />
      </div>
      <div>
        <h2 className="text-base font-semibold">You don&apos;t have access to this page</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          This area is limited to {needs}. If you think you should have access, ask the person
          who runs this server.
        </p>
      </div>
      <Button asChild variant="outline" className="mt-1">
        <Link href="/">Back to Discover</Link>
      </Button>
    </div>
  );
}
