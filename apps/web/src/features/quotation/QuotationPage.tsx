import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Role } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { useQueryDetail } from "@/features/query-wizard/useQueryDetail";
import {
  StageRail,
  isRfqStageEnabled,
  isQuotesStageEnabled,
  isQuotationStageEnabled,
} from "@/features/rfq-workspace/StageRail";
import { QueryOverviewHeader } from "@/features/rfq-workspace/QueryOverviewHeader";
import { RouteDiagram } from "@/features/query-wizard/steps/legs/RouteDiagram";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtUsd } from "@/features/compare/money";
import { errorMessage } from "@/features/compare/errorMessage";
import { useQuotation, usePatchQuotation, useReviseQuotation } from "./useQuotation";
import { ChargeEditorTable } from "./ChargeEditorTable";
import { QuotationPreviewDialog } from "./QuotationPreviewDialog";

const MARGIN_DEBOUNCE_MS = 400;

/**
 * QuotationPage — the internal Client Quotation builder (`/queries/:id/quotation`, S5.8 Task 5).
 * Manager+ only, mirroring the server's `@Roles(ADMINISTRATOR, MANAGER)` gate on both `GET`/`PATCH
 * .../quotation` (task-3 report) — an EXECUTIVE viewer sees nothing here and `useQuotation`'s
 * `enabled` flag stops the read request from ever firing for them, not just from rendering its
 * result.
 *
 * Reuses the Stage-4/5 executive shell exactly like `CompareQuotesPage`: `StageRail` (active
 * "quotation") + `QueryOverviewHeader` + `RouteDiagram`, then a sticky margin bar and one
 * `ChargeEditorTable` per priced leg.
 *
 * Margin edits are debounced (ambiguity resolution #2); a line edit commits on blur. Both PATCH
 * through `usePatchQuotation`. 🔴 `onCommitOverride` always composes the FULL overrides map from
 * the last-known `quotation.overrides` before sending it — the API replaces the stored map
 * wholesale, so sending only the just-edited key would silently release every other pin (the brief's
 * flagged contract; see `useQuotation.ts`'s doc comment).
 *
 * A DRAFT renders fully editable (margin input, per-line overrides, "Reset overrides", "Preview
 * quotation" opening `QuotationPreviewDialog`). Once ISSUED or SUPERSEDED, the design's rule is
 * absolute (S5.8 Task 6, ambiguity resolution #3): "no margin input, no editable prices, no issue
 * button" — so the margin bar's `Input` becomes plain text, every `ChargeEditorTable` renders
 * `readOnly`, "Reset overrides" and "Preview quotation" both disappear, and an ISSUED quotation
 * gets a "Revise" button (`useReviseQuotation`) in their place — the ONLY door back to an editable
 * DRAFT once something has been issued (backend: `QuotationService.revise`).
 */
export function QuotationPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canWrite = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;

  const query = useQueryDetail(id);
  const quotation = useQuotation(id, canWrite);
  const patch = usePatchQuotation(id);
  const revise = useReviseQuotation(id);

  const [previewOpen, setPreviewOpen] = useState(false);

  // Local, editable margin text — seeded from the server's own value and re-seeded whenever THAT
  // changes (first load, or after a PATCH round-trips), but never overwritten mid-keystroke.
  const [marginInput, setMarginInput] = useState("");
  const seededMarginRef = useRef<number | null>(null);
  const marginTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (quotation.data && seededMarginRef.current !== quotation.data.marginPct) {
      seededMarginRef.current = quotation.data.marginPct;
      setMarginInput(String(quotation.data.marginPct));
    }
  }, [quotation.data]);

  useEffect(
    () => () => {
      if (marginTimerRef.current !== null) clearTimeout(marginTimerRef.current);
    },
    [],
  );

  function onMarginChange(value: string) {
    setMarginInput(value);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    if (marginTimerRef.current !== null) clearTimeout(marginTimerRef.current);
    marginTimerRef.current = setTimeout(() => {
      patch.mutate({ marginPct: parsed });
    }, MARGIN_DEBOUNCE_MS);
  }

  // 🔴 See module doc comment — always the FULL map. Seeded from the LAST MAP WE SENT, falling
  // back to the server's own copy only before the first send (final review IMPORTANT #6):
  // `quotation.data.overrides` is refreshed by a PATCH's `onSuccess`, so blurring line A and then
  // line B before A's response lands seeded B's wholesale PATCH from pre-A state and silently
  // discarded A's hand-set price — a lost update on a money field, with no error and no visual tell
  // until the next refetch snapped the line back.
  const sentOverridesRef = useRef<Record<string, number> | null>(null);

  function sendOverrides(next: Record<string, number>) {
    sentOverridesRef.current = next;
    patch.mutate(
      { overrides: next },
      // A rejected PATCH never reached the server, so the ref would otherwise keep seeding every
      // later edit from state that doesn't exist there. Fall back to the server's own last-known
      // map instead.
      { onError: () => { sentOverridesRef.current = null; } },
    );
  }

  function onCommitOverride(legId: string, lineId: string, value: number | undefined) {
    if (!quotation.data) return;
    const key = `${legId}:${lineId}`;
    const nextOverrides = { ...(sentOverridesRef.current ?? quotation.data.overrides) };
    if (value === undefined) delete nextOverrides[key];
    else nextOverrides[key] = value;
    sendOverrides(nextOverrides);
  }

  function onResetOverrides() {
    sendOverrides({});
  }

  if (!id) return <p role="alert" className="text-sm text-destructive">Missing query id.</p>;

  if (!canWrite) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Manager or Administrator access required to view the quotation.
      </p>
    );
  }

  if (query.isLoading || quotation.isLoading)
    return <p className="text-sm text-muted-foreground">Loading quotation…</p>;
  if (query.isError || !query.data)
    return <p role="alert" className="text-sm text-destructive">Failed to load the query.</p>;
  if (quotation.isError || !quotation.data)
    return <p role="alert" className="text-sm text-destructive">Failed to load the quotation.</p>;

  const q = query.data;
  const qu = quotation.data;
  const pricing = qu.pricing;
  // S5.8 Task 6, ambiguity resolution #3 — ISSUED/SUPERSEDED both render read-only; only a DRAFT
  // is still editable or previewable-then-issuable.
  const isDraft = qu.status === "DRAFT";

  return (
    <div className="space-y-4" data-testid="quotation-page">
      <StageRail
        queryId={id}
        active="quotation"
        rfqEnabled={isRfqStageEnabled(q.status)}
        quotesEnabled={isQuotesStageEnabled(q.status)}
        quotationEnabled={isQuotationStageEnabled(q.status)}
      />

      <div className="space-y-5">
        <QueryOverviewHeader query={q} />

        <section
          aria-label="Route overview"
          className="rounded-lg border border-border bg-card p-4 sm:p-6"
        >
          <h2 className="mb-3 font-display text-sm font-semibold text-muted-foreground">
            Route overview
          </h2>
          <RouteDiagram detail={q} findings={[]} />
        </section>

        <div
          data-testid="margin-bar"
          className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 shadow-sm"
        >
          <div className="flex items-center gap-2">
            <Label htmlFor={isDraft ? "margin-pct" : undefined}>Margin %</Label>
            {isDraft ? (
              <Input
                id="margin-pct"
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={marginInput}
                onChange={(e) => onMarginChange(e.target.value)}
                className="w-24"
              />
            ) : (
              <span className="font-medium">{qu.marginPct}%</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-6 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Cost total
              </div>
              <div className="font-medium">{fmtUsd(pricing.costTotalUsd)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Margin value
              </div>
              <div className="font-medium">{fmtUsd(pricing.marginValueUsd)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Client total
              </div>
              <div className="text-lg font-semibold">{fmtUsd(pricing.clientTotalUsd)}</div>
            </div>
          </div>

          {isDraft && (
            <Button type="button" variant="outline" onClick={onResetOverrides} disabled={patch.isPending}>
              Reset overrides
            </Button>
          )}
        </div>

        {/* `!isDraft` here means ISSUED, full stop. A SUPERSEDED row can never reach this
            component: `getOrCreateDraft` returns only the current DRAFT or ISSUED row (and mints a
            fresh DRAFT past a superseded one — final review CRITICAL #3), while `patch`/`issue`/
            `revise` answer a non-DRAFT with 409/404 rather than a DTO. The final review flagged
            the old `status === "ISSUED" ? … : "…superseded…"` ternary's second arm as dead, and it
            stays dead after the CRITICAL #3 fix — that fix makes the reopen-then-re-award path
            hand back a NEW DRAFT, which is precisely what keeps a SUPERSEDED row off this screen.
            `readOnly={!isDraft}` below is kept as-is: it is a status-agnostic "not editable" gate,
            not a second copy of this reasoning. */}
        {!isDraft && (
          <p data-testid="quotation-status-note" className="text-sm text-muted-foreground">
            This quotation has been issued and is read-only. Use Revise to start a new draft.
          </p>
        )}

        {patch.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(patch.error, "Failed to save the quotation change.")}
          </p>
        )}
        {revise.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(revise.error, "Failed to start a new draft.")}
          </p>
        )}

        <div className="space-y-3">
          {pricing.legs.map((leg) => (
            <ChargeEditorTable
              key={leg.legId}
              leg={leg}
              onCommitOverride={onCommitOverride}
              readOnly={!isDraft}
            />
          ))}
          {pricing.legs.length === 0 && (
            <p className="text-sm text-muted-foreground">No priced legs yet.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <span data-testid="grand-total" className="text-lg font-semibold">
            Grand total {fmtUsd(pricing.clientTotalUsd)}
          </span>
          <div className="flex items-center gap-2">
            {qu.status === "ISSUED" && (
              <Button
                type="button"
                variant="outline"
                onClick={() => revise.mutate()}
                disabled={revise.isPending}
              >
                {revise.isPending ? "Revising…" : "Revise"}
              </Button>
            )}
            {isDraft && (
              <Button type="button" onClick={() => setPreviewOpen(true)}>
                Preview quotation
              </Button>
            )}
          </div>
        </div>
      </div>

      {isDraft && (
        <QuotationPreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          queryId={id}
          quotation={qu}
          defaultRecipientEmail={q.contactEmail ?? ""}
        />
      )}
    </div>
  );
}
