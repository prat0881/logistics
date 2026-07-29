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

function pad(n: number): string { return String(n).padStart(2, "0"); }

export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocal(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);            // interpreted as viewer-local wall time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
