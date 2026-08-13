import type { CargoDto } from "@svyft/shared";
import { cargoLabel } from "@svyft/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface CargoAssignmentControlProps {
  cargo: CargoDto[];
  value: string[];
  onChange: (ids: string[]) => void;
  /**
   * packageId → the code of another leg that already carries it on a shared endpoint
   * (a parallel drop / merge — see `computePackageConflicts`). Such a package is disabled
   * here so the invalid split can't be built — unless it's already selected on this
   * leg, in which case it stays enabled so the user can still remove it.
   */
  conflicts?: Map<string, string>;
}

/**
 * D7 package tick list — packages grouped under their cargo's PO/Ref, one Checkbox
 * per `PackageDto` (label = packageNo). Toggling a row adds/removes its package id
 * from `value` and calls `onChange`. A package that would form a parallel drop/merge
 * for this leg is disabled with an "already on L#" note.
 */
export function CargoAssignmentControl({
  cargo = [],
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

  const groups = cargo.filter((c) => c.packages.length > 0);

  if (groups.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">No packages yet — add them in Step 3.</p>
        <p className="text-xs text-muted-foreground">
          Assign at least one package before Create Query (D7).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((c) => (
        <div key={c.id} className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{cargoLabel(c)}</p>
          <ul className="space-y-2 pl-2">
            {c.packages.map((p) => {
              const checked = value.includes(p.id);
              const conflictLeg = conflicts?.get(p.id);
              // Block adding a conflicting package, but never lock an already-selected
              // one (so a pre-existing bad selection can still be cleared).
              const disabled = Boolean(conflictLeg) && !checked;
              return (
                <li key={p.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`package-assign-${p.id}`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={() => toggle(p.id)}
                  />
                  <label
                    htmlFor={`package-assign-${p.id}`}
                    className={cn(
                      "text-sm select-none",
                      disabled ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer",
                    )}
                  >
                    {p.packageNo}
                  </label>
                  {disabled && (
                    <span className="text-xs text-warning">
                      Already on {conflictLeg} — a package can’t be split across parallel legs
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Assign at least one package before Create Query (D7).
      </p>
    </div>
  );
}
