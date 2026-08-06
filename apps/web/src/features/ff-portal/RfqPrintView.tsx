import type { ChargeZone, FfPortalLegDto, FfPortalRfqDto, FfPortalSeededCharge } from "@svyft/shared";
import { formatDate, formatDateTime } from "@/lib/dates";
import { CargoManifestTable } from "./CargoManifestTable";

/**
 * RfqPrintView — a clean, print-friendly rendering of the RFQ *request* document
 * (design §4.8.14): what the freight forwarder was asked to quote (header, per-leg masked
 * route, package list, and the charge structure to price) — NOT the FF's in-progress quote
 * amounts, which live in separate per-leg forms and aren't reachable from here.
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
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Charges requested
        </h3>
        <ChargeStructureTable seededCharges={leg.seededCharges} />
      </div>
    </section>
  );
}

/** The charge structure the FF is being asked to price — label + zone only. Amounts are always
 *  blank: this is the request document, not the FF's priced quote (that lives in the per-leg
 *  form, not this component). */
function ChargeStructureTable({ seededCharges }: { seededCharges: FfPortalSeededCharge[] }) {
  if (seededCharges.length === 0) {
    return <p className="text-sm text-muted-foreground">No preset charge lines seeded for this leg.</p>;
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
            <tr key={`${c.definitionKey ?? c.label}-${i}`} className="border-b border-border/60 last:border-b-0">
              <td className="px-3 py-2 text-muted-foreground">{c.zone ? ZONE_LABELS[c.zone] : "—"}</td>
              <td className="px-3 py-2">{c.label}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">—</td>
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
      <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Terms &amp; Conditions</h3>
      <p>
        This document is a request for quote (RFQ) and does not itself constitute a binding agreement. Rates
        submitted through the Svyft Logistics portal are subject to review and confirmation. Quotes must remain
        valid through the &ldquo;Quote validity until&rdquo; date shown above and be denominated in the stated
        currency. Charges must reflect the cargo, route and terms described in this document; Svyft Logistics
        reserves the right to amend or withdraw this RFQ prior to award.
      </p>
    </section>
  );
}
