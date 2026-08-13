import { useMemo, useState } from "react";
import type { ChargeLineDefinitionDto, QueryLegDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useSetChargeSelection } from "./useChargeConfig";

// Hoisted to module scope (not declared inside ConfigureChargesPopover's body): a component
// defined inline in a parent's render gets a fresh function identity every render, so React
// treats each re-render as a different component type and fully unmounts/remounts the row
// (losing DOM/focus identity) instead of just updating props. Keeping it stable here means
// toggling a checkbox updates that same checkbox in place.
function Section({
  title,
  rows,
  selected,
  disabled,
  onToggle,
  onSelectAll,
  onClear,
}: {
  title: string;
  rows: ChargeLineDefinitionDto[];
  selected: Set<string>;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  if (rows.length === 0) return null;
  const allSelected = rows.every((c) => selected.has(c.id));
  const noneSelected = rows.every((c) => !selected.has(c.id));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted-foreground">{title}</p>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs font-normal text-muted-foreground"
            disabled={disabled || allSelected}
            onClick={onSelectAll}
            aria-label={`Select all ${title}`}
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs font-normal text-muted-foreground"
            disabled={disabled || noneSelected}
            onClick={onClear}
            aria-label={`Clear ${title}`}
          >
            Clear
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        {rows.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={selected.has(c.id)}
              disabled={disabled}
              onCheckedChange={(v) => onToggle(c.id, v === true)}
            />
            {c.label}
          </label>
        ))}
      </div>
    </div>
  );
}

// Hoisted alongside Section, same reason (stable identity across parent re-renders). Cores
// are always-on and can't be edited, so they render as checked + disabled checkboxes rather
// than a plain text note — same visual language as the toggleable sections above, just
// visibly locked, which reads clearer than a note once the list is long.
function CoresSection({ cores }: { cores: ChargeLineDefinitionDto[] }) {
  if (cores.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t pt-3">
      <p className="text-xs font-semibold text-muted-foreground">Always included</p>
      <div className="space-y-1">
        {cores.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked disabled />
            {c.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export function ConfigureChargesPopover({
  queryId,
  leg,
  catalogue,
  disabled,
}: {
  queryId: string;
  leg: QueryLegDto;
  catalogue: ChargeLineDefinitionDto[];
  disabled: boolean;
}) {
  const mut = useSetChargeSelection(queryId, leg.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(leg.chargeLineDefinitionIds));
  const forMode = useMemo(
    () => catalogue.filter((c) => c.mode === leg.mode),
    [catalogue, leg.mode],
  );
  const cores = forMode.filter((c) => c.role === "CORE");
  const standard = forMode.filter((c) => c.role === "STANDARD");
  const tagDriven = forMode.filter((c) => c.role === "TAG_DRIVEN");

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
    mut.mutate([...next]);
  };

  // Select all / Clear apply to one section's rows at a time, as a single optimistic update
  // + single PATCH (not one call per row) — same commit shape as toggle above.
  const applyRows = (rows: ChargeLineDefinitionDto[], on: boolean) => {
    const next = new Set(selected);
    for (const c of rows) {
      if (on) next.add(c.id);
      else next.delete(c.id);
    }
    setSelected(next);
    mut.mutate([...next]);
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Configure charges ({selected.size})
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure charges</DialogTitle>
          <DialogDescription>
            Choose which charge lines this leg's freight forwarders will quote.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <Section
            title="Standard"
            rows={standard}
            selected={selected}
            disabled={disabled}
            onToggle={toggle}
            onSelectAll={() => applyRows(standard, true)}
            onClear={() => applyRows(standard, false)}
          />
          <Section
            title="Tag-driven"
            rows={tagDriven}
            selected={selected}
            disabled={disabled}
            onToggle={toggle}
            onSelectAll={() => applyRows(tagDriven, true)}
            onClear={() => applyRows(tagDriven, false)}
          />
          <CoresSection cores={cores} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
