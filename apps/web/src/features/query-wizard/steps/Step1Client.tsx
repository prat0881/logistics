import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { QuerySaveInput } from "@svyft/shared";

export interface StepSaveFn {
  (): Promise<QuerySaveInput | void>;
}

interface Step1ClientProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Step 1 — Client & Query (placeholder)
 *
 * Renders a minimal "Contact Name" field so the mint-flow test can exercise
 * the first-Save path without full Step-1 logic. Tasks 6–7 will replace this
 * with the real form.
 */
export function Step1Client({ registerSave }: Step1ClientProps) {
  const { register, getValues } = useForm<QuerySaveInput>({
    defaultValues: { contactName: "" },
  });

  const getValuesRef = useRef(getValues);
  getValuesRef.current = getValues;

  useEffect(() => {
    registerSave(async () => {
      return getValuesRef.current();
    });
  }, [registerSave]);

  return (
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">Step 1 — Client &amp; Query (placeholder, full form coming in Task 6)</p>
      <div className="space-y-1">
        <Label htmlFor="contactName">Contact Name</Label>
        <Input id="contactName" {...register("contactName")} placeholder="Contact name" />
      </div>
    </div>
  );
}
