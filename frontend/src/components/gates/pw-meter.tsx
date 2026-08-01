"use client";

// Password strength meter — same scoring as the old pwStrength() (app.js:2205).

export function pwStrength(p: string): number {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  return s; // 0..4
}

export function PwMeter({ value }: { value: string }) {
  const s = pwStrength(value);
  const tone =
    s <= 1 ? "w-1/4 bg-destructive" : s <= 2 ? "w-2/4 bg-yellow-500" : "w-full bg-emerald-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className={`h-full rounded-full transition-all ${value ? tone : "w-0"}`} />
    </div>
  );
}
