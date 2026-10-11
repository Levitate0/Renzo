"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

export interface SettingsNavSection {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Copied from Shiori (RenzoFrontend components/comp/layout/settings-section-nav.tsx)
 * so Renzo's settings pages use the identical section nav; keep in step.
 *
 * Section nav shared by /account and /settings: a vertical sidebar on wider
 * screens, and — on narrow ones — a trigger that opens the same list in a
 * full drawer (matching the app's main nav Sheet pattern, see command-bar.tsx)
 * rather than a compact inline dropdown.
 */
export function SettingsSectionNav({
  sections,
  activeId,
  onChange,
  drawerTitle,
}: {
  sections: readonly SettingsNavSection[];
  activeId: string;
  onChange: (id: string) => void;
  drawerTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const activeSection = sections.find((s) => s.id === activeId);

  const renderList = (onNavigate?: () => void) => (
    <nav aria-label={`${drawerTitle} sections`} className="flex flex-col gap-1">
      {sections.map((s) => {
        const Icon = s.icon;
        const active = s.id === activeId;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              onChange(s.id);
              onNavigate?.();
            }}
            aria-current={active ? "page" : undefined}
            className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            {active && <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />}
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{s.title}</span>
          </button>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Narrow screens: trigger opens the same list in a full drawer. */}
      <div className="lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              <span className="flex items-center gap-2 min-w-0">
                {activeSection && <activeSection.icon className="h-4 w-4 shrink-0" />}
                <span className="truncate">{activeSection?.title ?? "Choose a section"}</span>
              </span>
              <Menu className="h-4 w-4 shrink-0 opacity-60" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-4 overflow-auto" aria-describedby={undefined}>
            <div className="mb-3 text-lg font-semibold">{drawerTitle}</div>
            {renderList(() => setOpen(false))}
          </SheetContent>
        </Sheet>
      </div>

      {/* Wider screens: inline sidebar. */}
      <div className="hidden lg:block">{renderList()}</div>
    </>
  );
}
