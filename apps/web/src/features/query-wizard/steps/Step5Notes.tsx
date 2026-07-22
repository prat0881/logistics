import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChecklistItemStateDto } from "@svyft/shared";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { patchJson } from "@/lib/api";
import { useWizard } from "../WizardContext";
import { useSaveQuery } from "../useQueryDetail";
import type { StepSaveFn } from "./Step1Client";

interface Step5NotesProps {
  registerSave: (fn: StepSaveFn) => void;
}

/** Static label map keyed by the seeded checklist item keys */
export const CHECKLIST_LABELS: Record<string, string> = {
  "weight-confirmed": "Weight confirmed",
  "dimensions-confirmed": "Dimensions confirmed",
  "hs-code-received": "HS / HSN code received",
  "dg-confirmed": "DG / Non-DG confirmed",
  "msds-received": "MSDS received",
  "commercial-invoice": "Commercial invoice received",
  "packing-list": "Packing list received",
  "pickup-address": "Pickup address confirmed",
  "delivery-address": "Delivery address confirmed",
};

/** msds-received is only applicable when dgIndicator is true */
export const DG_CONDITIONAL_KEY = "msds-received";

export function Step5Notes({ registerSave }: Step5NotesProps) {
  const { detail, queryId } = useWizard();
  const { patch } = useSaveQuery();
  const qc = useQueryClient();

  // Internal Notes local state
  const [internalNotes, setInternalNotes] = useState<string>(
    detail?.internalNotes ?? "",
  );

  // Checklist local state: map itemKey -> checked
  const [checklistState, setChecklistState] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const item of detail?.checklist ?? []) {
      init[item.itemKey] = item.checked;
    }
    return init;
  });

  // Sync state when detail loads/changes
  useEffect(() => {
    if (detail) {
      setInternalNotes(detail.internalNotes ?? "");
      const next: Record<string, boolean> = {};
      for (const item of detail.checklist) {
        next[item.itemKey] = item.checked;
      }
      setChecklistState(next);
    }
  }, [detail]);

  // Use a ref to capture the latest state for registerSave
  const notesRef = useRef(internalNotes);
  notesRef.current = internalNotes;
  const checklistRef = useRef(checklistState);
  checklistRef.current = checklistState;

  useEffect(() => {
    registerSave(async () => {
      if (!queryId) return undefined;

      // (a) Save internal notes via patch
      await patch(queryId, { internalNotes: notesRef.current });

      // (b) Save checklist via checklist PATCH
      const items: ChecklistItemStateDto[] = Object.entries(checklistRef.current).map(
        ([itemKey, checked]) => ({ itemKey, checked }),
      );

      if (items.length > 0) {
        await patchJson(`/api/queries/${queryId}/checklist`, { items });
        await qc.invalidateQueries({ queryKey: ["query", queryId] });
      }

      return undefined;
    });
  }, [registerSave, queryId, patch, qc]);

  const charCount = internalNotes.length;

  // Get the checklist items in the canonical order using the label map keys
  const orderedKeys = Object.keys(CHECKLIST_LABELS);

  return (
    <div className="space-y-6 p-4">
      {/* Section: Internal Notes */}
      <div className="space-y-2">
        <label htmlFor="internalNotes" className="text-sm font-medium">
          Internal Notes <span className="text-destructive">*</span>
        </label>
        <Textarea
          id="internalNotes"
          aria-label="Internal Notes"
          value={internalNotes}
          onChange={(e) => setInternalNotes(e.target.value)}
          maxLength={500}
          placeholder="Add internal notes about this query…"
          rows={4}
        />
        <p className="text-xs text-muted-foreground text-right">
          {charCount}/500
        </p>
      </div>

      {/* Section: Checklist */}
      <div className="space-y-2">
        <h2 className="text-base font-semibold">Checklist <span className="text-destructive">*</span></h2>
        <div className="space-y-3">
          {orderedKeys.map((itemKey) => {
            const label = CHECKLIST_LABELS[itemKey];
            const checked = checklistState[itemKey] ?? false;

            return (
              <div
                key={itemKey}
                data-testid="checklist-row"
                className="flex items-center gap-3"
              >
                <Checkbox
                  id={`checklist-${itemKey}`}
                  checked={checked}
                  onCheckedChange={(value) => {
                    setChecklistState((prev) => ({
                      ...prev,
                      [itemKey]: value === true,
                    }));
                  }}
                  aria-label={label}
                />
                <label
                  htmlFor={`checklist-${itemKey}`}
                  className="text-sm cursor-pointer"
                >
                  {label}
                </label>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
