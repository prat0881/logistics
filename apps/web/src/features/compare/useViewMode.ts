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
 *
 * 🔴 **Call this EXACTLY ONCE per screen, at the top, and thread the pair down as props.**
 * The state is ordinary `useState`, so it is per-CALL, not per-browser: `useState`'s lazy
 * initialiser runs once per mount, and each caller therefore seeds from `localStorage` at ITS mount
 * and diverges from then on. S5.7 shipped with `CompareLegPanel` calling this per leg, so toggling
 * to Rows on LEG-1 left the already-mounted LEG-2 panel holding `"columns"` — the preference only
 * appeared to "carry" after a full page reload (final review IMPORTANT #1). `CompareQuotesPage` now
 * owns the single call and passes `viewMode`/`onViewModeChange` to every `CompareLegPanel`, the same
 * single-sourcing already used for `locked` and `fxAsOf`; `CompareLegPanel` takes both as REQUIRED
 * props so a second call site can't be added by accident. The cross-leg guarantee is covered in
 * `CompareQuotesPage.test.tsx` ("carries the view-mode preference across legs"), which is the only
 * place two consumers are concurrently mounted — a mount/unmount SEQUENCE (as in this file's
 * "a fresh mount picks up the persisted preference" test, which covers page reloads) cannot show it.
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
