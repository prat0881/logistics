import { useFormContext, useWatch, useFieldArray } from "react-hook-form";
import type {
  QuoteDraft,
  QuoteDraftCharge,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
// freight is already the AIR_MAIN_FREIGHT line inside `charges` (a normal common row).
const ROAD_FREIGHT_LABEL = "Road Freight";
const SEA_FREIGHT_LABEL = "Sea Freight";

// A fresh custom [+ Add Charge Line] row (design D1/D5, #6): common (`rateVariant: null`), no
// catalogue identity (`definitionKey`/`presetKey: null`) — this is exactly the shape
// `validateQuote`'s Q_CUSTOM_REMARK/Q_CUSTOM_AMOUNT loop (quote-engine.ts) recognizes as "custom".
function newCustomChargeRow(): QuoteDraftCharge {
  return {
    zone: null,
    definitionKey: null,
    presetKey: null,
    label: "",
    amount: null,
    rateVariant: null,
    note: "",
  };
}

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
  return (
    <NumberField
      aria-label={label}
      className="text-right"
      value={null}
      disabled
      onChange={() => {}}
    />
  );
}

/**
 * A common charge row (design D1): unlike the freight row, a common charge is priced ONCE — one
 * amount input spanning every variant column (`colSpan`), not one input per column. Optional
 * Note field (clears the $0-price Q_PRICED gate) and the Bill-of-Lading Select (Sea's
 * SEA_ORIGIN_BILL_OF_LADING line only) ride along in the same cell. `idx` is `undefined` when the
 * draft has no matching entry for this line at all (stale/legacy draft predating the current
 * catalogue) — degrades to a disabled NotApplicableCell, same convention as the old per-cell one.
 */
function CommonChargeRow({
  seeded,
  idx,
  value,
  colSpan,
  totalGrossWtKg,
}: {
  seeded: FfPortalSeededCharge;
  idx: number | undefined;
  value: QuoteDraftCharge | undefined;
  colSpan: number;
  totalGrossWtKg: number;
}): JSX.Element {
  const { setValue, register } = useFormContext<QuoteDraft>();
  const rowKey = seeded.definitionKey ?? seeded.label;

  if (idx == null) {
    return (
      <TableRow data-testid={`chargematrix-row-${rowKey}`}>
        <TableCell className="font-medium">{seeded.label}</TableCell>
        <TableCell colSpan={colSpan} className="align-top">
          <NotApplicableCell label={seeded.label} />
        </TableCell>
      </TableRow>
    );
  }

  if (seeded.inputType === "HEAVY_WEIGHT_CALC") {
    return (
      <TableRow data-testid={`chargematrix-row-${rowKey}`}>
        <TableCell className="font-medium">{seeded.label}</TableCell>
        <TableCell colSpan={colSpan} className="align-top">
          <HeavyWeightCalcRow index={idx} label={seeded.label} totalGrossWtKg={totalGrossWtKg} />
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow data-testid={`chargematrix-row-${rowKey}`}>
      <TableCell className="font-medium">{seeded.label}</TableCell>
      <TableCell colSpan={colSpan} className="align-top">
        <div className="space-y-1.5">
          <NumberField
            aria-label={seeded.label}
            className="text-right"
            value={value?.amount ?? null}
            onChange={(val) => setValue(`charges.${idx}.amount`, val, { shouldDirty: true })}
          />
          {/* Compact note (design/gate note, added per review round 1): validateQuote's Q_PRICED
              still requires a remark to quote a PLAIN line at exactly 0 (quote-engine.ts) and the
              retired panels' "Note (optional)" field was the only surface for it. Small/
              unobtrusive by design so a normal (non-zero) row stays dense; kept unconditionally
              visible rather than reveal-on-zero to avoid a11y/test churn from a second layer of
              conditional rendering. */}
          <Input
            aria-label={`Note for ${seeded.label}`}
            placeholder="Note (optional)"
            className="h-7 text-xs"
            {...register(`charges.${idx}.note` as const)}
          />
          {seeded.definitionKey === BILL_OF_LADING_KEY && (
            <Select
              value={value?.billOfLadingType ?? ""}
              onValueChange={(val) =>
                setValue(`charges.${idx}.billOfLadingType`, val as BillOfLadingType, {
                  shouldDirty: true,
                })
              }
            >
              <SelectTrigger aria-label="Bill of Lading type">
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
    </TableRow>
  );
}

/**
 * An FF-authored [+ Add Charge Line] row (design D1/D5, #6): editable label (there's no catalogue
 * text to fall back on), amount, remark, and a Remove button. `position` is this row's 1-based
 * rank among custom rows only (append-order) — used for a stable, content-independent aria-label
 * (the FF-typed `label` itself can't be the label source, unlike a catalogue row).
 */
function CustomChargeRow({
  idx,
  value,
  position,
  colSpan,
  onRemove,
}: {
  idx: number;
  value: QuoteDraftCharge | undefined;
  position: number;
  colSpan: number;
  onRemove: () => void;
}): JSX.Element {
  const { setValue } = useFormContext<QuoteDraft>();
  return (
    <TableRow data-testid={`chargematrix-row-custom-${idx}`}>
      <TableCell className="font-medium">
        {/* Fully controlled (value/onChange via setValue), NOT register() — a custom row's `idx`
            SHIFTS whenever an earlier custom row is removed (useFieldArray.remove splices the
            array), and an uncontrolled register()'d input can leave a stale/ghost value behind
            when React reuses the DOM node for a re-indexed row (confirmed empirically: `label`/
            catalogue rows never re-index, so register() is fine there — see CommonChargeRow). */}
        <Input
          aria-label={`Custom charge ${position} label`}
          placeholder="Charge label"
          value={value?.label ?? ""}
          onChange={(e) => setValue(`charges.${idx}.label`, e.target.value, { shouldDirty: true })}
        />
      </TableCell>
      <TableCell colSpan={colSpan} className="align-top">
        <div className="flex items-start gap-2">
          <div className="flex-1 space-y-1.5">
            <NumberField
              aria-label={`Custom charge ${position} amount`}
              className="text-right"
              value={value?.amount ?? null}
              onChange={(val) => setValue(`charges.${idx}.amount`, val, { shouldDirty: true })}
            />
            <Input
              aria-label={`Custom charge ${position} remark`}
              placeholder="Remark (required)"
              className="h-7 text-xs"
              value={value?.note ?? ""}
              onChange={(e) =>
                setValue(`charges.${idx}.note`, e.target.value, { shouldDirty: true })
              }
            />
          </div>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            aria-label={`Remove custom charge ${position}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * ChargeMatrix — the D1 integrated charge table (design §3.1/D1, Round 4): freight rows
 * (Road/Sea's `trucking`/`seaRates`) keep the per-variant columns; every `draft.charges` row is
 * now COMMON (one row per definitionKey, priced once) and renders as a SINGLE amount input
 * spanning the variant columns, not one per column. An Additional-charges subtotal, an
 * "Add Charge Line" affordance (common custom rows via `useFieldArray`), and a per-variant Grand
 * total close out the table. Replaces the v3 fully-per-variant matrix.
 */
export function ChargeMatrix({ seededCharges, mode }: ChargeMatrixProps): JSX.Element {
  const { control, setValue } = useFormContext<QuoteDraft>();
  // Full-draft watch (matches ChargeZonePanel's prior convention) — every cell in this matrix
  // reads live values off `draft`, so a single watch re-renders the whole grid on any keystroke.
  const draft = useWatch({ control }) as QuoteDraft;
  const { fields: chargeFields, append, remove } = useFieldArray({ control, name: "charges" });
  const columns = variantsForMode(mode);

  const charges = draft.charges ?? [];
  const trucking = draft.trucking ?? [];
  const seaRates = draft.seaRates ?? [];
  const cargo = draft.cargo ?? [];

  // Leg total cargo gross weight (design D4/#11) — forwarded to HeavyWeightCalcRow so it can
  // client-mirror the engine's Q_PIECE_WEIGHT (`pieceWeightKg` can't exceed this).
  const totalGrossWtKg = cargo.reduce((s, c) => s + c.grossWtKg, 0);

  // definitionKey → absolute index in `charges` — v4: every charge is common (one row per
  // definitionKey), so a cell's NumberField/Select binds to that ONE entry, not a (definitionKey,
  // rateVariant) pair.
  const chargeIndexByKey = new Map<string, number>();
  charges.forEach((c, idx) => {
    if (c.definitionKey) chargeIndexByKey.set(c.definitionKey, idx);
  });

  // Custom [+ Add Charge Line] rows (design D1/D5, #6) — the same Q_CUSTOM_* convention
  // (`!definitionKey && !presetKey`) validateQuote uses. Position (1-based, append order) drives
  // each row's stable aria-label, since the FF-typed label text can't be used for that.
  const customRows = charges
    .map((c, idx) => ({ c, idx, fieldId: chargeFields[idx]?.id ?? String(idx) }))
    .filter(({ c }) => !c.definitionKey && !c.presetKey);

  // Grand totals (finding #6) — keyed by variant (not raw index) so a mismatch between this
  // component's `mode` prop and the watched `draft.mode` (should never happen; both trace back to
  // `leg.mode`) can't silently misalign a total under the wrong column.
  const totals = computeQuoteTotals(draft);
  const totalsByKey = new Map(totals.variants.map((v) => [v.key, v] as const));

  const hasFreightRow = mode === "ROAD" || mode === "SEA";
  const isEmpty = !hasFreightRow && seededCharges.length === 0 && customRows.length === 0;
  const colCount = 1 + columns.length;

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
              <TableCell colSpan={colCount} className="py-6 text-center text-muted-foreground">
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
                          onChange={(val) =>
                            setValue(`trucking.${idx}.amount`, val, { shouldDirty: true })
                          }
                        />
                        {v === "DEDICATED" && (
                          <Select
                            value={trucking[idx].tonnage ?? ""}
                            onValueChange={(val) =>
                              setValue(`trucking.${idx}.tonnage`, val as TruckTonnage, {
                                shouldDirty: true,
                              })
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
                          onChange={(val) =>
                            setValue(`seaRates.${idx}.amount`, val, { shouldDirty: true })
                          }
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
            const idx = s.definitionKey ? chargeIndexByKey.get(s.definitionKey) : undefined;
            return (
              <CommonChargeRow
                key={s.definitionKey ?? s.label}
                seeded={s}
                idx={idx}
                value={idx != null ? charges[idx] : undefined}
                colSpan={columns.length}
                totalGrossWtKg={totalGrossWtKg}
              />
            );
          })}

          {customRows.map(({ c, idx, fieldId }, i) => (
            <CustomChargeRow
              key={fieldId}
              idx={idx}
              value={c}
              position={i + 1}
              colSpan={columns.length}
              onRemove={() => remove(idx)}
            />
          ))}

          <TableRow className="text-muted-foreground">
            <TableCell>Additional charges</TableCell>
            <TableCell
              colSpan={columns.length}
              data-testid="chargematrix-additional-subtotal"
              className="text-right font-mono tabular-nums"
            >
              {fmtAmount(totals.additionalChargeSum)}
            </TableCell>
          </TableRow>

          <TableRow>
            <TableCell colSpan={colCount} className="py-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => append(newCustomChargeRow())}
              >
                + Add Charge Line
              </Button>
            </TableCell>
          </TableRow>

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
