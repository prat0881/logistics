import { useFormContext, useWatch } from "react-hook-form";
import type {
  QuoteDraft,
  FfPortalSeededCharge,
  FreightMode,
  ChargeRateVariant,
  BillOfLadingType,
  TruckTonnage,
  ContainerSize,
} from "@svyft/shared";
import {
  variantsForMode,
  rateVariantLabel,
  computeQuoteTotals,
  TRUCK_TONNAGES,
  truckTonnageLabel,
  CONTAINER_SIZES,
  containerSizeLabel,
  BILL_OF_LADING_TYPES,
} from "@svyft/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";
import { HeavyWeightCalcRow } from "./HeavyWeightCalcRow";
import { fmtAmount } from "./format";

// The seeded Sea Zone-1 line that also carries a Bill of Lading type (§7.4.3.2) — detected by
// definitionKey, matching ChargeZonePanel's (now-retired) convention.
const BILL_OF_LADING_KEY = "SEA_ORIGIN_BILL_OF_LADING";
const BILL_OF_LADING_LABELS: Record<BillOfLadingType, string> = {
  ORIGINAL: "Original",
  TELEX: "Telex Release",
};

// The freight-rate row's label per mode (design §3.1): Road/Sea render it as an extra row sourced
// from `trucking`/`seaRates`, matching "<Mode> Freight" — Air needs no entry here at all, its
// freight is already the AIR_MAIN_FREIGHT line inside `seededCharges` (a normal row).
const ROAD_FREIGHT_LABEL = "Road Freight";
const SEA_FREIGHT_LABEL = "Sea Freight";

export interface ChargeMatrixProps {
  seededCharges: FfPortalSeededCharge[];
  mode: FreightMode | null;
}

function columnKey(v: ChargeRateVariant | null): string {
  return v ?? "AIR";
}
function columnLabel(v: ChargeRateVariant | null): string {
  return v ? rateVariantLabel(v) : "Air";
}
function cellLabel(rowLabel: string, v: ChargeRateVariant | null): string {
  return `${rowLabel} — ${columnLabel(v)}`;
}

/** A (header, variant) cell with no seeded charge for that pair — not applicable to this variant
 *  (design §6 finding #3): rendered as a disabled, blank NumberField so the grid stays intact
 *  (same cell count/alignment every row) while making clear nothing can be entered here. */
function NotApplicableCell({ label }: { label: string }): JSX.Element {
  return <NumberField aria-label={label} className="text-right" value={null} disabled onChange={() => {}} />;
}

/**
 * ChargeMatrix — the per-variant charge matrix (design §3.1/§6 finding #3/#6): rows are the
 * distinct charge headers seeded onto this leg (`seededCharges`, already one entry per
 * definitionKey) plus the mode's freight-rate row; columns are `variantsForMode(mode)` (Road/Sea:
 * two columns, Air: a single implicit column — the matrix degrades to a one-column list). Each
 * cell binds to the `charges` entry matching (definitionKey, rateVariant===column) — Task 3's
 * server seed (and draftFromDto's client fallback) fan every line out across every column up
 * front, so a cell is only missing (→ greyed/disabled) when a stored draft predates the current
 * charge configuration. Replaces ChargeZonePanel/RoadChargesPanel/TruckingBlocks/SeaChargesPanel.
 */
export function ChargeMatrix({ seededCharges, mode }: ChargeMatrixProps): JSX.Element {
  const { control, setValue, register } = useFormContext<QuoteDraft>();
  // Full-draft watch (matches ChargeZonePanel's prior convention) — every cell in this matrix
  // reads live values off `draft`, so a single watch re-renders the whole grid on any keystroke.
  const draft = useWatch({ control }) as QuoteDraft;
  const columns = variantsForMode(mode);

  const charges = draft.charges ?? [];
  const trucking = draft.trucking ?? [];
  const seaRates = draft.seaRates ?? [];

  // (definitionKey, rateVariant) → absolute index in `charges`, so a cell's NumberField/Select
  // binds to the exact seeded entry for that (row, column) pair (Task 3's seed shape).
  const chargeIndexByKey = new Map<string, number>();
  charges.forEach((c, idx) => chargeIndexByKey.set(`${c.definitionKey ?? ""}::${columnKey(c.rateVariant)}`, idx));

  // Per-column grand totals (finding #6) — keyed by variant (not raw index) so a mismatch between
  // this component's `mode` prop and the watched `draft.mode` (should never happen; both trace
  // back to `leg.mode`) can't silently misalign a total under the wrong column.
  const totalsByKey = new Map(computeQuoteTotals(draft).variants.map((v) => [v.key, v] as const));

  const hasFreightRow = mode === "ROAD" || mode === "SEA";
  const isEmpty = !hasFreightRow && seededCharges.length === 0;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Charge</TableHead>
            {columns.map((v) => (
              <TableHead key={columnKey(v)} className="text-right">
                {columnLabel(v)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isEmpty && (
            <TableRow>
              <TableCell colSpan={1 + columns.length} className="py-6 text-center text-muted-foreground">
                No charge lines configured for this leg.
              </TableCell>
            </TableRow>
          )}

          {mode === "ROAD" && (
            <TableRow data-testid="chargematrix-row-freight">
              <TableCell className="font-medium">{ROAD_FREIGHT_LABEL}</TableCell>
              {columns.map((v) => {
                const idx = trucking.findIndex((t) => t.rateVariant === v);
                const label = cellLabel(ROAD_FREIGHT_LABEL, v);
                return (
                  <TableCell key={columnKey(v)} className="align-top">
                    {idx === -1 ? (
                      <NotApplicableCell label={label} />
                    ) : (
                      <div className="space-y-2">
                        <NumberField
                          aria-label={label}
                          className="text-right"
                          value={trucking[idx].amount ?? null}
                          onChange={(val) => setValue(`trucking.${idx}.amount`, val, { shouldDirty: true })}
                        />
                        {v === "DEDICATED" && (
                          <Select
                            value={trucking[idx].tonnage ?? ""}
                            onValueChange={(val) =>
                              setValue(`trucking.${idx}.tonnage`, val as TruckTonnage, { shouldDirty: true })
                            }
                          >
                            <SelectTrigger aria-label={`Tonnage — ${columnLabel(v)}`}>
                              <SelectValue placeholder="Tonnage" />
                            </SelectTrigger>
                            <SelectContent>
                              {TRUCK_TONNAGES.map((t) => (
                                <SelectItem key={t} value={t}>
                                  {truckTonnageLabel(t)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          )}

          {mode === "SEA" && (
            <TableRow data-testid="chargematrix-row-freight">
              <TableCell className="font-medium">{SEA_FREIGHT_LABEL}</TableCell>
              {columns.map((v) => {
                const idx = seaRates.findIndex((r) => r.rateVariant === v);
                const label = cellLabel(SEA_FREIGHT_LABEL, v);
                return (
                  <TableCell key={columnKey(v)} className="align-top">
                    {idx === -1 ? (
                      <NotApplicableCell label={label} />
                    ) : (
                      <div className="space-y-2">
                        <NumberField
                          aria-label={label}
                          className="text-right"
                          value={seaRates[idx].amount ?? null}
                          onChange={(val) => setValue(`seaRates.${idx}.amount`, val, { shouldDirty: true })}
                        />
                        {v === "FCL" && (
                          <Select
                            value={seaRates[idx].containerSize ?? ""}
                            onValueChange={(val) =>
                              setValue(`seaRates.${idx}.containerSize`, val as ContainerSize, {
                                shouldDirty: true,
                              })
                            }
                          >
                            <SelectTrigger aria-label={`Container size — ${columnLabel(v)}`}>
                              <SelectValue placeholder="Container size" />
                            </SelectTrigger>
                            <SelectContent>
                              {CONTAINER_SIZES.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {containerSizeLabel(c)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          )}

          {seededCharges.map((s) => {
            const rowKey = s.definitionKey ?? s.label;
            return (
              <TableRow key={rowKey} data-testid={`chargematrix-row-${rowKey}`}>
                <TableCell className="font-medium">{s.label}</TableCell>
                {columns.map((v) => {
                  const idx = chargeIndexByKey.get(`${s.definitionKey ?? ""}::${columnKey(v)}`);
                  const label = cellLabel(s.label, v);

                  if (idx == null) {
                    return (
                      <TableCell key={columnKey(v)} className="align-top">
                        <NotApplicableCell label={label} />
                      </TableCell>
                    );
                  }

                  if (s.inputType === "HEAVY_WEIGHT_CALC") {
                    return (
                      <TableCell key={columnKey(v)} className="align-top">
                        <HeavyWeightCalcRow index={idx} label={label} />
                      </TableCell>
                    );
                  }

                  return (
                    <TableCell key={columnKey(v)} className="align-top">
                      <div className="space-y-1.5">
                        <NumberField
                          aria-label={label}
                          className="text-right"
                          value={charges[idx].amount ?? null}
                          onChange={(val) => setValue(`charges.${idx}.amount`, val, { shouldDirty: true })}
                        />
                        {/* Compact note (design/gate note, not in the original brief — added per
                            review round 1): validateQuote's Q_PRICED still requires a remark to
                            quote a PLAIN line at exactly 0 (quote-engine.ts) and the retired
                            panels' "Note (optional)" field was the only surface for it. Small/
                            unobtrusive by design so a normal (non-zero) row stays dense; kept
                            unconditionally visible rather than reveal-on-zero to avoid a11y/test
                            churn from a second layer of conditional rendering. */}
                        <Input
                          aria-label={`Note for ${label}`}
                          placeholder="Note (optional)"
                          className="h-7 text-xs"
                          {...register(`charges.${idx}.note` as const)}
                        />
                        {s.definitionKey === BILL_OF_LADING_KEY && (
                          <Select
                            value={charges[idx].billOfLadingType ?? ""}
                            onValueChange={(val) =>
                              setValue(`charges.${idx}.billOfLadingType`, val as BillOfLadingType, {
                                shouldDirty: true,
                              })
                            }
                          >
                            <SelectTrigger aria-label={`Bill of Lading type — ${columnLabel(v)}`}>
                              <SelectValue placeholder="B/L type" />
                            </SelectTrigger>
                            <SelectContent>
                              {BILL_OF_LADING_TYPES.map((b) => (
                                <SelectItem key={b} value={b}>
                                  {BILL_OF_LADING_LABELS[b]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}

          <TableRow className="bg-muted/40 font-semibold">
            <TableCell>Grand total</TableCell>
            {columns.map((v) => {
              const t = totalsByKey.get(columnKey(v));
              // Blank-rate convention (matches QuoteSummary): a variant whose own freight rate was
              // never entered shows "–", not a possibly-misleading partial sum. Air has no separate
              // rate cell (variantRate() always returns null for Air — see quote-engine.ts), so it's
              // excluded from this check or its total would always read blank.
              const blank = t != null && t.rateAmount == null && t.key !== "AIR";
              return (
                <TableCell
                  key={columnKey(v)}
                  data-testid={`chargematrix-total-${columnKey(v)}`}
                  className="text-right font-mono tabular-nums"
                >
                  {t == null || blank ? "–" : fmtAmount(t.grandTotal)}
                </TableCell>
              );
            })}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
