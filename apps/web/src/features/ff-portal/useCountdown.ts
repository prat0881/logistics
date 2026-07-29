// useCountdown.ts
import { useEffect, useState } from "react";

export type CountdownTier = "calm" | "warning" | "urgent" | "expired";
export interface Countdown { text: string; tier: CountdownTier; expired: boolean; }

function pad(n: number): string { return String(n).padStart(2, "0"); }

function compute(deadlineIso: string): Countdown {
  const ms = new Date(deadlineIso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return { text: "Deadline passed", tier: "expired", expired: true };
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const text = d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : h > 0 ? `${pad(h)}h ${pad(m)}m` : `${pad(m)}m ${pad(s)}s`;
  const hours = ms / 3_600_000;
  const tier: CountdownTier = hours >= 24 ? "calm" : hours >= 12 ? "warning" : "urgent";
  return { text, tier, expired: false };
}

export function useCountdown(deadlineIso: string): Countdown {
  const [state, setState] = useState(() => compute(deadlineIso));
  useEffect(() => {
    setState(compute(deadlineIso));
    const id = setInterval(() => setState(compute(deadlineIso)), 1000);
    return () => clearInterval(id);
  }, [deadlineIso]);
  return state;
}
