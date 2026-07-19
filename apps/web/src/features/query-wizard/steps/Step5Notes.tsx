import { useEffect } from "react";
import type { StepSaveFn } from "./Step1Client";

interface Step5NotesProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Step 5 — Notes & Checklist (placeholder)
 * Full implementation coming in a later task.
 */
export function Step5Notes({ registerSave }: Step5NotesProps) {
  useEffect(() => {
    registerSave(async () => undefined);
  }, [registerSave]);

  return (
    <div className="p-4">
      <p className="text-sm text-muted-foreground">Step 5 — Notes &amp; Checklist (placeholder, full form coming in a later task)</p>
    </div>
  );
}
