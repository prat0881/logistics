import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Role } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { useQueryDetail } from "@/features/query-wizard/useQueryDetail";
import {
  StageRail,
  isRfqStageEnabled,
  isQuotesStageEnabled,
  isAwardStageEnabled,
} from "@/features/rfq-workspace/StageRail";
import { QueryOverviewHeader } from "@/features/rfq-workspace/QueryOverviewHeader";
import { RouteDiagram } from "@/features/query-wizard/steps/legs/RouteDiagram";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtUsd } from "@/features/compare/money";
import { errorMessage } from "@/features/compare/errorMessage";
import { useQuotation, usePatchQuotation } from "./useQuotation";
import { ChargeEditorTable } from "./ChargeEditorTable";

const MARGIN_DEBOUNCE_MS = 400;

/**
 * QuotationPage — the internal Client Quotation builder (`/queries/:id/quotation`, S5.8 Task 5).
 * Manager+ only, mirroring the server's `@Roles(ADMINISTRATOR, MANAGER)` gate on both `GET`/`PATCH
 * .../quotation` (task-3 report) — an EXECUTIVE viewer sees nothing here and `useQuotation`'s
 * `enabled` flag stops the read request from ever firing for them, not just from rendering its
 * result.
 *
 * Reuses the Stage-4/5 executive shell exactly like `CompareQuotesPage`: `StageRail` (active
 * "award") + `QueryOverviewHeader` + `RouteDiagram`, then a sticky margin bar and one
 * `ChargeEditorTable` per priced leg.
 *
 * Margin edits are debounced (ambiguity resolution #2); a line edit commits on blur. Both PATCH
 * through `usePatchQuotation`. 🔴 `onCommitOverride` always composes the FULL overrides map from
 * the last-known `quotation.overrides` before sending it — the API replaces the stored map
 * wholesale, so sending only the just-edited key would silently release every other pin (the brief's
 * flagged contract; see `useQuotation.ts`'s doc comment).
 *
 * The "Preview quotation" button is a deliberate stub — disabled, with a `title` pointing at Task 6,
 * which replaces it with the real dialog.
 */
export function QuotationPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canWrite = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;

  const query = useQueryDetail(id);
  const quotation = useQuotation(id, canWrite);
  const patch = usePatchQuotation(id);

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

  // 🔴 See module doc comment — always the FULL map, seeded from the server's last-known state.
  function onCommitOverride(legId: string, lineId: string, value: number | undefined) {
    if (!quotation.data) return;
    const key = `${legId}:${lineId}`;
    const nextOverrides = { ...quotation.data.overrides };
    if (value === undefined) delete nextOverrides[key];
    else nextOverrides[key] = value;
    patch.mutate({ overrides: nextOverrides });
  }

  function onResetOverrides() {
    patch.mutate({ overrides: {} });
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

  return (
    <div className="space-y-4" data-testid="quotation-page">
      <StageRail
        queryId={id}
        active="award"
        rfqEnabled={isRfqStageEnabled(q.status)}
        quotesEnabled={isQuotesStageEnabled(q.status)}
        awardEnabled={isAwardStageEnabled(q.status)}
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
            <Label htmlFor="margin-pct">Margin %</Label>
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

          <Button type="button" variant="outline" onClick={onResetOverrides} disabled={patch.isPending}>
            Reset overrides
          </Button>
        </div>

        {patch.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(patch.error, "Failed to save the quotation change.")}
          </p>
        )}

        <div className="space-y-3">
          {pricing.legs.map((leg) => (
            <ChargeEditorTable
              key={leg.legId}
              leg={leg}
              marginPct={qu.marginPct}
              onCommitOverride={onCommitOverride}
            />
          ))}
          {pricing.legs.length === 0 && (
            <p className="text-sm text-muted-foreground">No priced legs yet.</p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border pt-4">
          <span data-testid="grand-total" className="text-lg font-semibold">
            Grand total {fmtUsd(pricing.clientTotalUsd)}
          </span>
          {/* Task 6 wires the real preview dialog and removes this stub. */}
          <Button type="button" disabled title="Preview arrives in the next task">
            Preview quotation
          </Button>
        </div>
      </div>
    </div>
  );
}
