import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { REFERENCE_TAGS, referenceTagLabel, toCanonicalDim, cbmFromCanonical } from "@svyft/shared";
import type { ReferenceTag, DimUnit } from "@svyft/shared";

/**
 * Shared leaf form pieces for the cargo->package->item entry popup (Task 13/14/15).
 * Adapted from the retired CargoRowForm.tsx (flat-cargo model, deleted in this unit):
 * `NumericInput` and `ReferenceTags` are unchanged in spirit; `VolumeCbmPreview` is
 * re-grained from the old per-row `cbmFromDims(l,w,h,qty,unit)` (cargo qty * one set of
 * dims) to the new canonical-per-package `cbmFromCanonical(toCanonicalDim(...))` (a
 * package's own volume, no qty multiplier — BL-2 lives at the package).
 */

/** Controlled numeric input: shows "" for an unset value, reports back a `number` or
 *  `undefined` when cleared. Used for dims/weights/qty across Cargo/Package/Item forms.
 *  Spreads `...rest` (id/aria-describedby/aria-invalid/...) so it composes with
 *  `<FormControl>` — Radix `Slot` injects those onto its immediate child, and a
 *  component that doesn't forward them silently breaks `FormLabel`'s htmlFor
 *  association (getByLabelText then can't find the control). */
export function NumericInput({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
  ...rest
}: {
  value: string | number | undefined | null;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
} & Omit<
  React.ComponentPropsWithoutRef<"input">,
  "value" | "onChange" | "type" | "placeholder" | "className"
>) {
  return (
    <Input
      type="number"
      placeholder={placeholder}
      className={className}
      aria-label={ariaLabel}
      value={value === undefined || value === null || value === "" ? "" : String(value)}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? undefined : Number(v));
      }}
      {...rest}
    />
  );
}

/** Tag toggle grid (checkboxes over REFERENCE_TAGS, incl. DG). Each checkbox carries its
 *  own aria-label (the tag's label) so tests/screen readers can target it directly rather
 *  than relying on implicit <label> wrapping. */
export function ReferenceTags({
  value,
  onChange,
}: {
  value: ReferenceTag[];
  onChange: (v: ReferenceTag[]) => void;
}) {
  const toggle = (tag: ReferenceTag) => {
    if (value.includes(tag)) onChange(value.filter((t) => t !== tag));
    else onChange([...value, tag]);
  };

  return (
    <div className="flex flex-wrap gap-2">
      {REFERENCE_TAGS.map((tag) => (
        <label key={tag} className="flex items-center gap-1 cursor-pointer select-none text-xs">
          <Checkbox
            checked={value.includes(tag)}
            onCheckedChange={() => toggle(tag)}
            aria-label={referenceTagLabel(tag)}
          />
          <span>{referenceTagLabel(tag)}</span>
        </label>
      ))}
    </div>
  );
}

/** Live CBM preview for a package: entry-unit dims -> canonical cm -> cbmFromCanonical.
 *  No qty multiplier (unlike the retired CargoRowForm's cbmFromDims) — a package's own
 *  volume is per-unit; "N copies" are separate rows (Task 6/14), not a qty factor. */
export function VolumeCbmPreview({
  dimL,
  dimW,
  dimH,
  dimUnit,
}: {
  dimL: number | undefined;
  dimW: number | undefined;
  dimH: number | undefined;
  dimUnit: DimUnit;
}) {
  const hasAll = !!dimL && !!dimW && !!dimH && dimL > 0 && dimW > 0 && dimH > 0;
  const cbm = hasAll
    ? cbmFromCanonical(
        toCanonicalDim(dimL, dimUnit),
        toCanonicalDim(dimW, dimUnit),
        toCanonicalDim(dimH, dimUnit),
      )
    : null;
  return (
    <Input
      readOnly
      aria-label="Volume (CBM)"
      className="bg-muted font-mono tabular-nums"
      value={cbm !== null ? cbm.toFixed(4) : "—"}
    />
  );
}
