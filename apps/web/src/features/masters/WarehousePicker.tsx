import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Paginated, WarehouseDto } from "@svyft/shared";
import { ApiError, fetchJson, putJson } from "@/lib/api";
import { Button } from "@/components/ui/button";

/**
 * Owner-agnostic child editor, following ContactList's pattern: `ownerPath`/`ownerId` name the
 * parent, `submitError` is rendered through role="alert" with the server's own message (never
 * swallowed), and a missing `ownerId` renders the same "save this record first" guard.
 *
 * `assigned` is a prop, not fetched here — the owning form page reads it (via
 * `useOwnerWarehouses`) so it shares cache/invalidation with the rest of the page. This
 * component only fetches the *unassigned* pool (`GET /api/warehouses?unassigned=true`) and
 * merges it with `assigned` for the checkbox list: a warehouse this owner already has would
 * otherwise vanish from the list the moment it's checked, since ?unassigned=true excludes it.
 */
export function WarehousePicker({
  ownerPath,
  ownerId,
  assigned,
}: {
  ownerPath: "freight-forwarders" | "clients";
  ownerId?: string;
  assigned: WarehouseDto[];
}) {
  const qc = useQueryClient();
  const unassignedKey = ["warehouses", "unassigned"];
  const unassigned = useQuery({
    queryKey: unassignedKey,
    queryFn: () => fetchJson<Paginated<WarehouseDto>>("/api/warehouses?unassigned=true&pageSize=100"),
    enabled: Boolean(ownerId),
  });

  const [selected, setSelected] = useState<Set<string>>(() => new Set(assigned.map((w) => w.id)));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Re-sync the checked set whenever the assigned list changes underneath us (initial load,
  // or a refetch after a save) — otherwise a stale `assigned` from first render would linger.
  useEffect(() => {
    setSelected(new Set(assigned.map((w) => w.id)));
  }, [assigned]);

  if (!ownerId) {
    return <p className="text-sm text-muted-foreground">Save this record before assigning warehouses.</p>;
  }

  const options = new Map<string, WarehouseDto>();
  for (const w of unassigned.data?.items ?? []) options.set(w.id, w);
  for (const w of assigned) options.set(w.id, w);
  const sorted = [...options.values()].sort((a, b) => a.name.localeCompare(b.name));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSave() {
    setSubmitError(null);
    setIsSaving(true);
    try {
      await putJson(`/api/${ownerPath}/${ownerId}/warehouses`, { warehouseIds: [...selected] });
      await Promise.all([
        qc.invalidateQueries({ queryKey: [ownerPath, ownerId, "warehouses"] }),
        qc.invalidateQueries({ queryKey: unassignedKey }),
      ]);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Failed to save warehouses");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section aria-label="Warehouses" className="space-y-4">
      <h2 className="font-display text-lg font-semibold tracking-tight">Warehouses</h2>
      {submitError && (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      )}
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">No warehouses available to assign.</p>
      ) : (
        <ul className="space-y-1">
          {sorted.map((w) => (
            <li key={w.id}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} />
                {w.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" onClick={onSave} disabled={isSaving}>
        {isSaving ? "Saving…" : "Save warehouses"}
      </Button>
    </section>
  );
}
