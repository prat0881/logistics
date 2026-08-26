import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  chargeLineCreateSchema,
  categoriesForMode,
  chargeVariantsForMode,
  FREIGHT_MODES,
  type ChargeCategory,
  type ChargeLineCreateInput,
  type ChargeVariant,
  type FreightMode,
} from "@svyft/shared";
import { ApiError, postJson, patchJson } from "@/lib/api";
import { useChargeCatalogueAdmin } from "../useMasters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CATEGORY_LABELS: Record<ChargeCategory, string> = {
  ORIGIN: "Origin Charges",
  FREIGHT: "Freight Charges",
  DESTINATION: "Destination Charges",
  ADDITIONAL: "Additional Charges",
};

// Mirrors ChargeLineInputType from packages/shared/src/charge-config.ts (a do-not-touch file
// for this build) — kept as a local literal list rather than importing CHARGE_LINE_INPUT_TYPES
// so this screen never needs that module's export surface to change.
const INPUT_TYPES = ["PLAIN", "TRUCKING", "WAREHOUSE_STAGING", "HEAVY_WEIGHT_CALC"] as const;
const INPUT_TYPE_LABELS: Record<(typeof INPUT_TYPES)[number], string> = {
  PLAIN: "Plain amount",
  TRUCKING: "Trucking (type / basis / amount)",
  WAREHOUSE_STAGING: "Warehouse staging",
  HEAVY_WEIGHT_CALC: "Heavy-weight calculation",
};

export function ChargeLineFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);

  // No single-row GET exists for this resource (by design — see task-13 report); the admin
  // list is the only source of an existing row's current values, same shape ContactList uses
  // for its owner-scoped list.
  const admin = useChargeCatalogueAdmin();
  const existing = admin.data?.find((l) => l.id === id);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ChargeLineCreateInput>({
    resolver: zodResolver(chargeLineCreateSchema),
    defaultValues: { mode: "ROAD", isAdditional: false, inputType: "PLAIN" },
  });

  useEffect(() => {
    if (existing && existing.category) {
      reset({
        mode: existing.mode,
        variant: existing.variant,
        category: existing.category,
        label: existing.label,
        isAdditional: existing.isAdditional,
        inputType: existing.inputType as ChargeLineCreateInput["inputType"],
        sortOrder: existing.sortOrder,
      });
    }
  }, [existing, reset]);

  // mode drives both the category and variant option lists — categoriesForMode/
  // chargeVariantsForMode read the same mode-scoping the API validates against, so the form
  // never duplicates that rule locally.
  const mode = (useWatch({ control, name: "mode" }) ?? "ROAD") as FreightMode;
  const category = useWatch({ control, name: "category" });
  const variant = useWatch({ control, name: "variant" });

  // A prior mode's category/variant selection can be invalid for the newly-chosen mode (e.g.
  // "Destination" was picked under Air, then Mode changes to Road, which has no Destination
  // category at all). Left alone, react-hook-form keeps that stale value registered — the
  // <select> visually falls back to showing some in-range option (the browser's own reaction
  // to its previously-selected <option> disappearing), but the value actually validated and
  // submitted stays the old, now-invalid one, so Save silently does nothing (a validation
  // error with no rendered message for these two fields). Explicitly re-point both to a valid
  // option for the mode whenever the current selection falls out of range, keeping the
  // registered value and what's visually shown in agreement.
  useEffect(() => {
    if (isEdit) return; // mode/category/variant are locked and already correct when editing
    const validCategories = categoriesForMode(mode);
    if (category && !validCategories.includes(category as ChargeCategory)) {
      setValue("category", validCategories[0], { shouldValidate: true });
    }
    const validVariants = chargeVariantsForMode(mode);
    if (variant && !validVariants.includes(variant as ChargeVariant)) {
      setValue("variant", validVariants[0], { shouldValidate: true });
    }
  }, [mode, category, variant, isEdit, setValue]);

  async function onSubmit(values: ChargeLineCreateInput) {
    setSubmitError(null);
    try {
      if (id) {
        // chargeLineUpdateSchema is .strict() and picks only label/sortOrder/isActive/
        // inputType — mode/variant/category/isAdditional are immutable after creation and
        // must never be sent, or the API 400s.
        await patchJson(`/api/charge-line-definitions/${id}`, {
          label: values.label,
          sortOrder: values.sortOrder,
          inputType: values.inputType,
        });
      } else {
        await postJson("/api/charge-line-definitions", values);
      }
      await qc.invalidateQueries({ queryKey: ["charge-catalogue-admin"] });
      navigate("/masters/charge-catalogue");
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not save this charge line");
    }
  }

  return (
    <div className="max-w-md space-y-8">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" aria-label="Charge line form">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          {isEdit ? "Edit charge line" : "New charge line"}
        </h1>
        {submitError && (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        )}
        {isEdit && (
          <div className="space-y-1">
            <Label htmlFor="key">Key</Label>
            <p id="key" className="font-mono text-sm text-muted-foreground">
              {existing?.key ?? (admin.isLoading ? "Loading…" : "")}
            </p>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="mode">Mode</Label>
          <select
            id="mode"
            disabled={isEdit}
            {...register("mode")}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {FREIGHT_MODES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {isEdit && (
            <p className="text-sm text-muted-foreground">
              Mode is fixed after creation, along with category, variant and additional charge.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="category">Category</Label>
          <select
            id="category"
            disabled={isEdit}
            {...register("category")}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {categoriesForMode(mode).map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
          {isEdit && (
            <p className="text-sm text-muted-foreground">
              Category is fixed after creation, along with mode, variant and additional charge
              — it determines how quotes group this charge.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="variant">Variant</Label>
          <select
            id="variant"
            disabled={isEdit}
            {...register("variant")}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {chargeVariantsForMode(mode).map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          {isEdit && (
            <p className="text-sm text-muted-foreground">
              Variant is fixed after creation, along with mode, category and additional charge.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="label">Label</Label>
          <Input id="label" {...register("label")} />
          {errors.label && (
            <p role="alert" className="text-sm text-destructive">{errors.label.message}</p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={isEdit} {...register("isAdditional")} />
          Additional charge
        </label>
        {isEdit && (
          <p className="text-sm text-muted-foreground">
            Additional charge is fixed after creation, along with mode, category and variant
            above.
          </p>
        )}
        <div className="space-y-1">
          <Label htmlFor="inputType">Input type</Label>
          <select
            id="inputType"
            {...register("inputType")}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {INPUT_TYPES.map((t) => (
              <option key={t} value={t}>{INPUT_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
        {isEdit && (
          <div className="space-y-1">
            <Label htmlFor="sortOrder">Sort order</Label>
            <Input id="sortOrder" type="number" {...register("sortOrder", { valueAsNumber: true })} />
          </div>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
      </form>
    </div>
  );
}
