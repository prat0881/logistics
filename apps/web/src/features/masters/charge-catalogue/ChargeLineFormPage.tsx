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
import { postJson, patchJson } from "@/lib/api";
import { useChargeCatalogueAdmin } from "../useMasters";
import { MasterForm, FormSection, Field, SelectField, masterErrorMessage } from "../form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CATEGORY_LABELS: Record<ChargeCategory, string> = {
  ORIGIN: "Origin Charges",
  FREIGHT: "Freight Charges",
  DESTINATION: "Destination Charges",
  ADDITIONAL: "Additional Charges",
};

// resolveChargeConfig (packages/shared/src/charge-config.ts, a do-not-touch file for this
// build) resolves ONLY PLAIN and HEAVY_WEIGHT_CALC lines. TRUCKING and WAREHOUSE_STAGING lines
// price through the leg's trucking / warehouse rate rows, which seedQuoteDraft builds from the
// leg's ENDPOINTS — never from a catalogue row. So a new line created as either of those is not
// merely filtered out of some view: nothing in the system would ever read it. It would save
// successfully and be invisible forever. Only the two values below are offered for selection;
// the other two are rendered read-only on the two seeded rows that legitimately carry them
// (ROAD_CORE_TRUCKING, ROAD_WH_HANDLING).
const SELECTABLE_INPUT_TYPES = ["PLAIN", "HEAVY_WEIGHT_CALC"] as const;

// Mirrors ChargeLineInputType from packages/shared/src/charge-config.ts — kept as a local
// literal map rather than importing that module's export surface, same rationale as the type
// list above.
const INPUT_TYPE_LABELS: Record<string, string> = {
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

  // A row already carrying TRUCKING or WAREHOUSE_STAGING (from before this restriction, or
  // seeded that way) must stay locked to that value — the dropdown never offers a path back to
  // it, so it cannot be edited here at all, only viewed with an explanation.
  const isInputTypeLocked =
    isEdit &&
    existing != null &&
    !SELECTABLE_INPUT_TYPES.includes(existing.inputType as (typeof SELECTABLE_INPUT_TYPES)[number]);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    formState: { errors, isSubmitting, isDirty },
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
        // must never be sent, or the API 400s. sortOrder is never sent: it has no field on
        // this form (see task-13 report — the number is display-only row order, never stored
        // on a quote). inputType is only sent when it is actually editable here; a locked row
        // (TRUCKING/WAREHOUSE_STAGING) renders no control for it and must not overwrite it
        // with whatever the resolver defaulted the unregistered field to.
        await patchJson(`/api/charge-line-definitions/${id}`, {
          label: values.label,
          ...(isInputTypeLocked ? {} : { inputType: values.inputType }),
        });
      } else {
        await postJson("/api/charge-line-definitions", values);
      }
      await qc.invalidateQueries({ queryKey: ["charge-catalogue-admin"] });
      navigate("/masters/charge-catalogue");
    } catch (err) {
      setSubmitError(masterErrorMessage(err, "Could not save this charge line"));
    }
  }

  const err = (name: keyof ChargeLineCreateInput) => errors[name]?.message as string | undefined;

  return (
    <MasterForm
      title={isEdit ? "Edit charge line" : "New charge line"}
      error={submitError}
      onSubmit={handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      onCancel={() => navigate("/masters/charge-catalogue")}
      isDirty={isDirty}
      recordNoun="charge line"
    >
      {isEdit && (
        <div className="space-y-1">
          <Label htmlFor="key">Key</Label>
          <p id="key" className="font-mono text-sm text-muted-foreground">
            {existing?.key ?? (admin.isLoading ? "Loading…" : "")}
          </p>
        </div>
      )}
      <FormSection title="Classification">
        <div className="space-y-1">
          <Label htmlFor="mode">Mode</Label>
          <select
            id="mode"
            disabled={isEdit}
            {...register("mode")}
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm"
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
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm"
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
            className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm"
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
        </div>
      </FormSection>
      <FormSection title="Presentation">
        <Field id="label" label="Label" error={err("label")}>
          <Input id="label" {...register("label")} />
        </Field>
        {isInputTypeLocked ? (
          <div className="space-y-1">
            <span className="text-sm font-medium">Input type</span>
            <p className="text-sm text-muted-foreground">
              {INPUT_TYPE_LABELS[existing!.inputType] ?? existing!.inputType}
            </p>
            <p className="text-sm text-muted-foreground">
              This line prices through the portal's rate rows, not the charge matrix.
            </p>
          </div>
        ) : (
          <SelectField
            id="inputType"
            label="Input type"
            error={err("inputType")}
            options={SELECTABLE_INPUT_TYPES.map((t) => ({ value: t, label: INPUT_TYPE_LABELS[t] }))}
            registration={register("inputType")}
          />
        )}
      </FormSection>
    </MasterForm>
  );
}
