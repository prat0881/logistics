import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { computeHeavyWeightAmount } from "@svyft/shared";
import { NumberField } from "./NumberField";
import { fmtAmount } from "./format";

export interface HeavyWeightCalcRowProps {
  index: number;
  label: string;
  // Leg total cargo gross weight — Σ draft.cargo[].grossWtKg (design D4/#11). Passed in rather
  // than read off the form here: this component only has ITS OWN charge index in scope, not the
  // whole draft; ChargeMatrix (which DOES watch the full draft) computes and forwards it.
  totalGrossWtKg: number;
}

export function HeavyWeightCalcRow({
  index,
  label,
  totalGrossWtKg,
}: HeavyWeightCalcRowProps): JSX.Element {
  const { control, setValue } = useFormContext<QuoteDraft>();
  const row = useWatch({ control, name: `charges.${index}` });
  const piece = row?.pieceWeightKg ?? null;
  const limit = row?.airlineLimitKg ?? null;
  const rate = row?.ratePerExcessKg ?? null;
  const amount =
    piece != null && limit != null && rate != null
      ? computeHeavyWeightAmount(piece, limit, rate)
      : null;
  // Client mirror of quote-engine.ts's Q_PIECE_WEIGHT (design D4): a single piece heavier than
  // the entire manifested shipment is a data-entry error. Strict `>` — exactly equal is fine,
  // matching the engine exactly so this never disagrees with the submit-time gate.
  const pieceExceedsGross = piece != null && piece > totalGrossWtKg;
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="text-sm font-medium">{label}</div>
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Piece weight (kg)</label>
          <NumberField
            aria-label={`Piece weight (kg) for ${label}`}
            aria-invalid={pieceExceedsGross}
            value={piece}
            onChange={(v) => setValue(`charges.${index}.pieceWeightKg`, v, { shouldDirty: true })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Airline limit (kg)</label>
          <NumberField
            aria-label={`Airline limit (kg) for ${label}`}
            value={limit}
            onChange={(v) => setValue(`charges.${index}.airlineLimitKg`, v, { shouldDirty: true })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Rate / excess kg</label>
          <NumberField
            aria-label={`Rate per excess kg for ${label}`}
            value={rate}
            onChange={(v) => setValue(`charges.${index}.ratePerExcessKg`, v, { shouldDirty: true })}
          />
        </div>
      </div>
      {pieceExceedsGross && (
        <p role="alert" className="text-xs text-destructive">
          Piece weight ({piece} kg) cannot exceed the cargo&rsquo;s total gross weight (
          {totalGrossWtKg} kg)
        </p>
      )}
      <div className="flex justify-between text-sm" data-testid={`hwc-amount-${index}`}>
        <span className="text-muted-foreground">Computed surcharge</span>
        <span className="font-mono tabular-nums font-medium">
          {amount == null ? "—" : fmtAmount(amount)}
        </span>
      </div>
    </div>
  );
}
