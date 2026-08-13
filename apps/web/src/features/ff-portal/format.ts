export function fmtDecimal(v: string | number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(dp) : "—";
}

export function fmtAmount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtWeight(t: number): string {
  return Number.isFinite(t) ? t.toFixed(3) : "—";
}

export function fmtCbm(v: string | number | null | undefined): string {
  return fmtDecimal(v, 4);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocal(local: string): string | null {
  if (!local) return null;
  const d = new Date(local); // interpreted as viewer-local wall time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "Now" in the same `datetime-local` wall-clock format `toDatetimeLocal` produces (design D3) —
 *  the `min` every FF datetime field (TransitPlanForm, WarehouseStaging) sets so the browser
 *  picker can't offer a past moment in the first place. Client-side UX only; the engine's
 *  unconditional Q_PAST_DATE rule (quote-engine.ts's validateQuote) is the enforcement half this
 *  can't be bypassed by editing the DOM. Callers compute this once per render and reuse it across
 *  every field on that pass, rather than calling it separately per field. */
export function nowDatetimeLocal(): string {
  return toDatetimeLocal(new Date().toISOString());
}
