import { useCallback, useState } from "react";

const KEY = "svyft.compare.viewMode";

/** The two Compare Quotes grid orientations (S5.7 T2) — offers-as-columns (S5.6 default, best when
 *  few forwarders quoted) or offers-as-rows (better once many forwarders quoted and columns would
 *  scroll off-screen). Both render from the same `ComparisonRowModel` (T1) / `METRICS`, so this
 *  type only selects presentation. */
export type ViewMode = "columns" | "rows";

/**
 * useViewMode — a single GLOBAL preference (not per-leg, not per-query — ambiguity resolution #3),
 * persisted to one `localStorage` key so an executive's chosen orientation carries across legs and
 * page loads. Read/write are both wrapped in try/catch: private-mode or storage-disabled browsers
 * throw on `localStorage` access, and this screen must never crash because of a UI preference —
 * the read falls back to `"columns"` (the S5.6 default, so every existing caller that never
 * touches this hook keeps behaving exactly as before) and the write is best-effort only.
 */
export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(KEY) === "rows" ? "rows" : "columns";
    } catch {
      return "columns"; // private-mode / storage-disabled browsers must not crash the screen
    }
  });
  const set = useCallback((m: ViewMode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* preference is best-effort */
    }
  }, []);
  return [mode, set];
}
