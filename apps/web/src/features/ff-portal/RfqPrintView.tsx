import type {
  ChargeZone,
  ChargeRateVariant,
  FfPortalLegDto,
  FfPortalRfqDto,
  FfPortalSeededCharge,
  FreightMode,
  QuoteDraft,
  QuoteDraftCharge,
} from "@svyft/shared";
import {
  variantsForMode,
  rateVariantLabel,
  effectiveChargeAmount,
  computeQuoteTotals,
} from "@svyft/shared";
import { formatDate, formatDateTime } from "@/lib/dates";
import { CargoManifestTable } from "./CargoManifestTable";
import { fmtAmount } from "./format";

/**
 * RfqPrintView — a print-friendly rendering of the RFQ document (design §4.8.14): header,
 * per-leg masked route, package list, and the charge structure. Renders charges from
 * `leg.draft` (Task 3's server-populated `QuoteDraft`): pre-submission (RFQ_SENT) that's a
 * seeded blank per-variant matrix, so every cell correctly reads "—" — this is the *request*,
 * what the FF is being asked to quote.
 *
 * Post-submission (QUOTED) this is the FF's own reference copy of what they *submitted* (design
 * §6 finding #8) — this component reads `leg.draft`'s per-variant charges / freight rate /
 * chargeable weight / notes instead of always rendering `seededCharges`' structurally-`null`
 * amounts (the original bug). This relies on `FfPortalService.submit()` (ff-portal.service.ts)
 * persisting the submitted draft back onto `Quote.draftJson` (instead of nulling it) so
 * `resolveScope`'s GET returns the real submitted figures for a QUOTED leg rather than falling
 * back to `seedQuoteDraft`'s blank matrix — safe because a change-order re-freeze only clears
 * `draftJson` for the REFRESHING (RFQ_SENT) quotes on a leg, never a QUOTED one (see
 * change-order.strategy.ts and task-8-report.md for the full root-cause trace). Degrades to the
 * pre-Task-3 blank `seededCharges` rendering when `leg.draft` is `null` (defensive — the real API
 * no longer sends that, but tests/older snapshots may).
 *
 * Still never the FF's in-progress, unsaved keystrokes — those live only in the per-leg edit
 * form's local state and aren't reachable from here.
 *
 * Mounted by `PortalShell` in two places: inside a read-only preview Dialog, and inside a
 * `hidden print:block` container that `window.print()` turns into a PDF via the browser's own
 * "Save as PDF" (no PDF library — see the Unit-4 task decision). Semantic HTML + CSS-variable
 * colors only, no interactive controls, so it renders identically in both places.
 */
export interface RfqPrintViewProps {
  rfq: FfPortalRfqDto;
}

const ZONE_LABELS: Record<ChargeZone, string> = {
  ORIGIN: "Origin",
  MAIN_FREIGHT: "Main freight",
  DESTINATION: "Destination",
};

export function RfqPrintView({ rfq }: RfqPrintViewProps): JSX.Element {
  return (
    <article className="space-y-8 bg-background text-sm text-foreground">
      <RfqPrintHeader rfq={rfq} />

      <div className="space-y-8">
        {rfq.legs.map((leg) => (
          <LegPrintSection key={leg.legId} leg={leg} />
        ))}
      </div>

      <TermsAndConditions />
    </article>
  );
}

function RfqPrintHeader({ rfq }: { rfq: FfPortalRfqDto }) {
  return (
    <header className="space-y-3 border-b border-border pb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-lg font-semibold tracking-tight">
          Svyft Logistics — Request for Quote
        </h1>
        <span className="font-mono tabular-nums text-sm">{rfq.rfqNumber}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        <PrintField label="Freight forwarder" value={rfq.freightForwarder.companyName} />
        <PrintField label="Incoterms" value={rfq.incoterms ?? "—"} />
        <PrintField label="Currency" value={rfq.currency ?? "—"} />
        <PrintField label="Submission deadline" value={formatDateTime(rfq.submissionDeadline)} />
        <PrintField
          label="Quote validity until"
          value={rfq.quoteValidityUntil ? formatDate(rfq.quoteValidityUntil) : "—"}
        />
      </dl>
    </header>
  );
}

function PrintField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/** name · city · country — the same address-masking whitelist as ScopedRouteDiagram: never a
 *  street address or contact detail, because the frozen portal DTO doesn't carry those at all. */
function maskedLocation(
  loc: { country: string | null; name: string | null; city: string | null } | null,
): string {
  if (!loc) return "—";
  const parts = [loc.name, loc.city, loc.country].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function LegPrintSection({ leg }: { leg: FfPortalLegDto }) {
  const draft = leg.draft;
  return (
    <section className="space-y-3 break-inside-avoid">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
        <h2 className="font-mono text-sm font-semibold tabular-nums">{leg.manifest.legCode}</h2>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {leg.mode ?? "Mode not set"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {maskedLocation(leg.manifest.origin)}
        <span aria-hidden="true"> → </span>
        {maskedLocation(leg.manifest.destination)}
      </p>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Package list
        </h3>
        <CargoManifestTable cargo={leg.manifest.cargo} />
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Charges requested
          </h3>
          {draft && (
            <p className="text-sm">
              <span className="text-muted-foreground">Chargeable weight (kg): </span>
              <span className="font-mono tabular-nums font-medium">
                {draft.chargedWeightKg != null ? draft.chargedWeightKg.toFixed(3) : "—"}
              </span>
            </p>
          )}
        </div>
        {draft ? (
          <ChargeMatrixPrintTable seededCharges={leg.seededCharges} mode={leg.mode} draft={draft} />
        ) : (
          <SeededChargesTable seededCharges={leg.seededCharges} />
        )}
      </div>

      {draft?.notes && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </h3>
          <p className="whitespace-pre-wrap text-sm">{draft.notes}</p>
        </div>
      )}
    </section>
  );
}

function columnKey(v: ChargeRateVariant | null): string {
  return v ?? "AIR";
}
function columnLabel(v: ChargeRateVariant | null): string {
  return v ? rateVariantLabel(v) : "Air";
}

// Matches ChargeMatrix.tsx's own (module-private) freight-row labels exactly (design §3.1: the
// freight-rate row's label per mode) — Air needs no entry here, its freight is already the
// AIR_MAIN_FREIGHT line inside `charges`, rendered as a normal row below.
const ROAD_FREIGHT_LABEL = "Road Freight";
const SEA_FREIGHT_LABEL = "Sea Freight";

/** A charge cell counts as "priced" once it carries a usable amount — a literal `amount`, or
 *  (for a HEAVY_WEIGHT_CALC line) all three calc inputs. Mirrors quote-engine.ts's (unexported)
 *  chargeCellPriced / ff-portal.service.ts's identical local copy (both already duplicate this
 *  same check — see their comments). Needed here only to decide "—" vs a real figure; the amount
 *  itself always comes from the shared `effectiveChargeAmount`, so the printed total can never
 *  drift from `computeQuoteTotals`'s. */
function chargeCellHasAmount(c: QuoteDraftCharge): boolean {
  return (
    c.amount != null ||
    (c.pieceWeightKg != null && c.airlineLimitKg != null && c.ratePerExcessKg != null)
  );
}

/**
 * The charge structure for this leg, rendered as a per-variant matrix (design §3.1/§6 finding
 * #8): rows are the distinct charge headers seeded onto the leg (`seededCharges`, already one
 * row per definitionKey) plus the mode's freight-rate row (Road/Sea only); columns are
 * `variantsForMode(mode)` — Air degrades to a single implicit column, matching ChargeMatrix.tsx
 * (the live editing matrix this mirrors). Cell amounts come from `draft.charges` /
 * `draft.trucking` / `draft.seaRates` — blank ("—") pre-submission (the seeded matrix has no
 * amounts yet), the FF's own submitted figures post-submission.
 */
function ChargeMatrixPrintTable({
  seededCharges,
  mode,
  draft,
}: {
  seededCharges: FfPortalSeededCharge[];
  mode: FreightMode | null;
  draft: QuoteDraft;
}) {
  const columns = variantsForMode(mode);
  const hasFreightRow = mode === "ROAD" || mode === "SEA";
  if (!hasFreightRow && seededCharges.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No preset charge lines seeded for this leg.</p>
    );
  }

  // Keyed by variant, not raw index (mirrors ChargeMatrix.tsx) — a mismatch between this
  // component's `mode` prop and the leg's own `draft.mode` (should never happen; both trace back
  // to `leg.mode`) can't silently misalign a total under the wrong column.
  const totalByKey = new Map(computeQuoteTotals(draft).variants.map((t) => [t.key, t] as const));

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Charge</th>
            {columns.map((v) => (
              <th key={columnKey(v)} className="px-3 py-2 text-right font-medium">
                {columnLabel(v)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {mode === "ROAD" && (
            <tr className="border-b border-border/60">
              <td className="px-3 py-2 font-medium">{ROAD_FREIGHT_LABEL}</td>
              {columns.map((v) => (
                <td key={columnKey(v)} className="px-3 py-2 text-right font-mono tabular-nums">
                  {fmtAmount(draft.trucking.find((t) => t.rateVariant === v)?.amount ?? null)}
                </td>
              ))}
            </tr>
          )}
          {mode === "SEA" && (
            <tr className="border-b border-border/60">
              <td className="px-3 py-2 font-medium">{SEA_FREIGHT_LABEL}</td>
              {columns.map((v) => (
                <td key={columnKey(v)} className="px-3 py-2 text-right font-mono tabular-nums">
                  {fmtAmount(draft.seaRates.find((r) => r.rateVariant === v)?.amount ?? null)}
                </td>
              ))}
            </tr>
          )}
          {seededCharges.map((s, i) => (
            <tr
              key={`${s.definitionKey ?? s.label}-${i}`}
              className="border-b border-border/60 last:border-b-0"
            >
              <td className="px-3 py-2">{s.label}</td>
              {columns.map((v) => {
                const cell = draft.charges.find(
                  (c) => c.definitionKey === s.definitionKey && c.rateVariant === v,
                );
                return (
                  <td key={columnKey(v)} className="px-3 py-2 text-right font-mono tabular-nums">
                    {cell && chargeCellHasAmount(cell)
                      ? fmtAmount(effectiveChargeAmount(cell))
                      : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="bg-muted/40 font-semibold">
            <td className="px-3 py-2">Grand total</td>
            {columns.map((v) => {
              const t = totalByKey.get(columnKey(v));
              return (
                <td key={columnKey(v)} className="px-3 py-2 text-right font-mono tabular-nums">
                  {t ? fmtAmount(t.grandTotal) : "—"}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Pre-Task-3-seed fallback (defensive: the live API always populates `leg.draft` now, but older
 *  snapshots/tests may still send `null`) — label + zone only, amounts always blank. Byte-for-byte
 *  the original (pre-finding-#8-fix) `ChargeStructureTable`. */
function SeededChargesTable({ seededCharges }: { seededCharges: FfPortalSeededCharge[] }) {
  if (seededCharges.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No preset charge lines seeded for this leg.</p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Zone</th>
            <th className="px-3 py-2 font-medium">Charge</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {seededCharges.map((c, i) => (
            <tr
              key={`${c.definitionKey ?? c.label}-${i}`}
              className="border-b border-border/60 last:border-b-0"
            >
              <td className="px-3 py-2 text-muted-foreground">
                {c.zone ? ZONE_LABELS[c.zone] : "—"}
              </td>
              <td className="px-3 py-2">{c.label}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                —
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TermsAndConditions() {
  return (
    <section className="space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
        Terms &amp; Conditions
      </h3>
      <p>
        This document is a request for quote (RFQ) and does not itself constitute a binding
        agreement. Rates submitted through the Svyft Logistics portal are subject to review and
        confirmation. Quotes must remain valid through the &ldquo;Quote validity until&rdquo; date
        shown above and be denominated in the stated currency. Charges must reflect the cargo, route
        and terms described in this document; Svyft Logistics reserves the right to amend or
        withdraw this RFQ prior to award.
      </p>
    </section>
  );
}
