import { useState } from "react";
import { truckTonnageLabel, type WarehouseVehicleUpsert, type TruckTonnage } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VehicleDialog } from "./VehicleDialog";

export function VehiclesSection({
  value,
  onChange,
}: {
  value: WarehouseVehicleUpsert[];
  onChange: (next: WarehouseVehicleUpsert[]) => void;
}) {
  const [openIndex, setOpenIndex] = useState<number | "new" | null>(null);

  function upsert(draft: WarehouseVehicleUpsert) {
    onChange(
      openIndex === "new" ? [...value, draft] : value.map((v, i) => (i === openIndex ? draft : v)),
    );
    setOpenIndex(null);
  }

  function remove() {
    if (typeof openIndex !== "number") return;
    onChange(value.filter((_, i) => i !== openIndex));
    setOpenIndex(null);
  }

  const editingInitial = typeof openIndex === "number" ? value[openIndex] : null;

  return (
    <section aria-label="Vehicles" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold tracking-tight">Vehicles</h2>
        <Button type="button" onClick={() => setOpenIndex("new")}>
          Add vehicle
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">No vehicles yet.</p>
      ) : (
        <Table aria-label="Vehicles">
          <TableHeader>
            <TableRow>
              <TableHead>Tonnage</TableHead>
              <TableHead>Quantity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {value.map((v, i) => (
              <TableRow key={v.id ?? `new-${i}`}>
                <TableCell>
                  <button
                    type="button"
                    className="font-medium underline-offset-4 hover:underline"
                    onClick={() => setOpenIndex(i)}
                  >
                    {truckTonnageLabel(v.tonnage as TruckTonnage)}
                  </button>
                </TableCell>
                <TableCell>{v.quantity}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <VehicleDialog
        key={openIndex ?? "closed"}
        open={openIndex !== null}
        initial={editingInitial ?? null}
        onSave={upsert}
        onRemove={remove}
        onClose={() => setOpenIndex(null)}
      />
    </section>
  );
}
