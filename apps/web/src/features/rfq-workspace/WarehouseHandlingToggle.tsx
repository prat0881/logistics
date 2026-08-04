import type { QueryLegDto, QueryPointDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { useSetWarehouseHandling } from "./useChargeConfig";

export function legTouchesWarehouse(leg: QueryLegDto, points: QueryPointDto[]): boolean {
  const t = (id: string | null) => points.find((p) => p.id === id)?.type;
  return t(leg.originPointId) === "WAREHOUSE" || t(leg.destinationPointId) === "WAREHOUSE";
}

export function WarehouseHandlingToggle({
  queryId, leg, disabled,
}: { queryId: string; leg: QueryLegDto; disabled: boolean }) {
  const mut = useSetWarehouseHandling(queryId, leg.id);
  const set = (v: boolean) =>
    mut.mutate(v, {
      onError: (e) => {
        if (e instanceof ApiError && e.status === 409) alert("This change routes through a change-order (leg already distributed).");
        else if (e instanceof ApiError && e.findings?.length) alert(e.findings[0].message);
      },
    });
  const val = leg.warehouseHandlingIncluded;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Warehouse handling included?</span>
      <Button size="sm" variant={val === true ? "default" : "outline"} disabled={disabled} onClick={() => set(true)}>Yes</Button>
      <Button size="sm" variant={val === false ? "default" : "outline"} disabled={disabled} onClick={() => set(false)}>No</Button>
      {val == null && <span className="text-xs text-amber-600">Decision required to distribute</span>}
    </div>
  );
}
