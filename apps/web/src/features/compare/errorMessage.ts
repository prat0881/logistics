import { ApiError } from "@/lib/api";

/**
 * Shared inline-error formatter for the Compare Quotes screen's mutation hooks (S5.6 — no toast
 * system in this repo, see `RfqWorkspace`/`FxRatesPage`'s house convention). Originally defined in
 * `MakerPanel.tsx` (Task 4) and re-pasted verbatim into the since-deleted `CheckerPanel.tsx`/
 * `GenerateGate.tsx` (Task 5); hoisted here on review so there's exactly one copy (task-5 review
 * Minor #2) — still the one `ApproveDialog`/`RejectDialog` reuse (S5.9.1 Task 2).
 */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
