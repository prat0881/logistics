import type { CargoDto } from "@svyft/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface CargoAssignmentControlProps {
  cargo: CargoDto[];
  value: string[];
  onChange: (ids: string[]) => void;
  /**
   * cargoId → the code of another leg that already carries it on a shared endpoint
   * (a parallel drop / merge — see `computeCargoConflicts`). Such a cargo is disabled
   * here so the invalid split can't be built — unless it's already selected on this
   * leg, in which case it stays enabled so the user can still remove it.
   */
  conflicts?: Map<string, string>;
}

/**
 * D7 cargo tick list — a controlled list of checkboxes, one per cargo row.
 * Toggling a row adds/removes its id from `value` and calls `onChange`. A cargo that
 * would form a parallel drop/merge for this leg is disabled with an "already on L#" note.
 */
export function CargoAssignmentControl({
  cargo,
  value,
  onChange,
  conflicts,
}: CargoAssignmentControlProps) {
  const toggle = (id: string) => {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  };

  if (cargo.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          No cargo yet — add rows in Step 3.
        </p>
        <p className="text-xs text-muted-foreground">
          Assign at least one cargo row before Create Query (D7).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {cargo.map((c) => {
          const checked = value.includes(c.id);
          const conflictLeg = conflicts?.get(c.id);
          // Block adding a conflicting cargo, but never lock an already-selected one
          // (so a pre-existing bad selection can still be cleared).
          const disabled = Boolean(conflictLeg) && !checked;
          return (
            <li key={c.id} className="flex items-center gap-2">
              <Checkbox
                id={`cargo-assign-${c.id}`}
                checked={checked}
                disabled={disabled}
                onCheckedChange={() => toggle(c.id)}
              />
              <label
                htmlFor={`cargo-assign-${c.id}`}
                className={cn(
                  "text-sm select-none",
                  disabled ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer",
                )}
              >
                <span className="font-medium">{c.poReference}</span>
                {" — "}
                <span>{c.productName}</span>
              </label>
              {disabled && (
                <span className="text-xs text-warning">
                  Already on {conflictLeg} — a cargo can’t be split across parallel legs
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        Assign at least one cargo row before Create Query (D7).
      </p>
    </div>
  );
}
