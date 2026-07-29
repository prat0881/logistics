import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { fmtAmount } from "./format";

export interface SubmissionBarProps {
  showDgNote: boolean;       // true if any cargo isDangerous
  currency: string | null;
  grandTotal: number;        // for the sticky total figure
  saving: boolean;
  submitting: boolean;
  savedAt: number | null;    // timestamp of last successful save
  disabled: boolean;         // deadline passed / not RFQ_SENT
  onSaveDraft: () => void;
  onSubmit: () => void;
}

export function SubmissionBar({
  showDgNote,
  currency,
  grandTotal,
  saving,
  submitting,
  savedAt,
  disabled,
  onSaveDraft,
  onSubmit,
}: SubmissionBarProps): JSX.Element {
  const { register, setValue } = useFormContext<QuoteDraft>();
  const termsConditions = useWatch<QuoteDraft, "termsConditions">({
    name: "termsConditions",
  });

  return (
    <div className="space-y-4">
      {/* DG Surcharge Note — only when dangerous goods present */}
      {showDgNote && (
        <div className="space-y-1">
          <Label htmlFor="dg-surcharge-note">DG surcharge note</Label>
          <Textarea
            id="dg-surcharge-note"
            placeholder="Add DG surcharge note..."
            {...register("dgSurchargeNote")}
          />
        </div>
      )}

      {/* Terms & Conditions */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="terms-conditions"
          checked={!!termsConditions}
          onCheckedChange={(c) =>
            setValue("termsConditions", c ? "Accepted" : null, {
              shouldDirty: true,
            })
          }
        />
        <Label htmlFor="terms-conditions" className="cursor-pointer">
          I accept the terms &amp; conditions
        </Label>
      </div>

      {/* Grand total + action buttons */}
      <div className="flex items-center justify-between gap-4">
        {/* Grand total display */}
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-display text-muted-foreground">
            Grand total
          </span>
          <span className="font-mono tabular-nums text-lg font-semibold">
            {fmtAmount(grandTotal)}
          </span>
          {currency && (
            <span className="text-sm text-muted-foreground">{currency}</span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {savedAt != null && (
            <span className="text-sm text-green-600">Saved ✓</span>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={saving || disabled}
            onClick={onSaveDraft}
          >
            Save draft
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={submitting || disabled}
            onClick={onSubmit}
          >
            Submit quote
          </Button>
        </div>
      </div>
    </div>
  );
}
