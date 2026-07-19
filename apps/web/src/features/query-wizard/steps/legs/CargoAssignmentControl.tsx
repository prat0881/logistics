import type { CargoDto } from "@svyft/shared";
import { Checkbox } from "@/components/ui/checkbox";

interface CargoAssignmentControlProps {
  cargo: CargoDto[];
  value: string[];
  onChange: (ids: string[]) => void;
}

/**
 * D7 cargo tick list — a controlled list of checkboxes, one per cargo row.
 * Toggling a row adds/removes its id from `value` and calls `onChange`.
 */
export function CargoAssignmentControl({
  cargo,
  value,
  onChange,
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
          No cargo yet — add rows in Step 3
        </p>
        <p className="text-xs text-amber-600">
          Assign at least one cargo row before Create Query (D7)
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {cargo.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <Checkbox
              id={`cargo-assign-${c.id}`}
              checked={value.includes(c.id)}
              onCheckedChange={() => toggle(c.id)}
            />
            <label
              htmlFor={`cargo-assign-${c.id}`}
              className="text-sm cursor-pointer select-none"
            >
              <span className="font-medium">{c.poReference}</span>
              {" — "}
              <span>{c.productName}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-amber-600">
        Assign at least one cargo row (D7)
      </p>
    </div>
  );
}
