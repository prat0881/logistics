import { useMemo, useState } from "react";
import type { ChargeLineDefinitionDto, QueryLegDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useSetChargeSelection } from "./useChargeConfig";

// Hoisted to module scope (not declared inside ConfigureChargesPopover's body): a component
// defined inline in a parent's render gets a fresh function identity every render, so React
// treats each re-render as a different component type and fully unmounts/remounts the row
// (losing DOM/focus identity) instead of just updating props. Keeping it stable here means
// toggling a checkbox updates that same checkbox in place.
function Section({
  title, rows, selected, disabled, onToggle,
}: {
  title: string;
  rows: ChargeLineDefinitionDto[];
  selected: Set<string>;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-muted-foreground">{title}</p>
      {rows.map((c) => (
        <label key={c.id} className="flex items-center gap-2 text-sm">
          <Checkbox checked={selected.has(c.id)} disabled={disabled}
            onCheckedChange={(v) => onToggle(c.id, v === true)} />
          {c.label}
        </label>
      ))}
    </div>
  );
}

export function ConfigureChargesPopover({
  queryId, leg, catalogue, disabled,
}: { queryId: string; leg: QueryLegDto; catalogue: ChargeLineDefinitionDto[]; disabled: boolean }) {
  const mut = useSetChargeSelection(queryId, leg.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(leg.chargeLineDefinitionIds));
  const forMode = useMemo(() => catalogue.filter((c) => c.mode === leg.mode), [catalogue, leg.mode]);
  const cores = forMode.filter((c) => c.role === "CORE");
  const standard = forMode.filter((c) => c.role === "STANDARD");
  const tagDriven = forMode.filter((c) => c.role === "TAG_DRIVEN");

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id); else next.delete(id);
    setSelected(next);
    mut.mutate([...next]);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">Configure charges ({selected.size})</Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3">
        <Section title="Standard" rows={standard} selected={selected} disabled={disabled} onToggle={toggle} />
        <Section title="Tag-driven" rows={tagDriven} selected={selected} disabled={disabled} onToggle={toggle} />
        {cores.length > 0 && (
          <p className="border-t pt-2 text-xs text-muted-foreground">
            Always included: {cores.map((c) => c.label).join(", ")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
