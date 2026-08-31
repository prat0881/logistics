import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Paginated, WarehouseDto } from "@svyft/shared";
import { fetchJson } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Owner-agnostic, fully controlled draft editor (Task 8). It no longer talks to the network to
 * save anything — the owning form page's single Save is the only commit point, carrying
 * `warehouseIds` alongside the parent record and its contacts in one request. This component
 * only fetches the *unassigned* pool (`GET /api/warehouses?unassigned=true`) to offer as
 * checkbox options; toggling a box calls `onChange` with the next id array, exactly like
 * `ContactsSection`'s `value`/`onChange` contract.
 *
 * `assigned` is still a prop, not fetched here — the owning form page reads it (via
 * `useOwnerWarehouses`) so it shares cache with the rest of the page. This component merges the
 * unassigned pool with `assigned` for the checkbox list: a warehouse this owner already has
 * would otherwise vanish from the list the moment it's checked, since ?unassigned=true excludes
 * it.
 */
export function WarehousePicker({
  ownerPath,
  value,
  onChange,
  assigned,
}: {
  ownerPath: "freight-forwarders" | "clients";
  value: string[];
  onChange: (ids: string[]) => void;
  assigned: WarehouseDto[];
}) {
  const [search, setSearch] = useState("");
  // The unassigned pool is capped at pageSize=100 (the API's max) and name-ordered, so a
  // warehouse alphabetically past the cap would otherwise be invisible with no hint it exists.
  // `q` re-scopes the *server-side* query rather than filtering the already-fetched 100, so
  // searching actually reaches warehouses outside the initial page. Unlike before Task 8, this
  // is not gated on an ownerId — a brand-new, unsaved record can now assign warehouses too,
  // since nothing commits until the parent's own Save.
  const unassigned = useQuery({
    queryKey: ["warehouses", "unassigned", ownerPath, search],
    queryFn: () =>
      fetchJson<Paginated<WarehouseDto>>(
        `/api/warehouses?unassigned=true&pageSize=100&q=${encodeURIComponent(search)}`,
      ),
  });

  // A stable, content-based signature rather than `assigned`'s own array identity. The parent
  // hands us `ownedWarehouses.data ?? []` — while that query is loading, `?? []` allocates a
  // brand-new empty array on *every* render (not just on real data changes), and even once
  // loaded, nothing guarantees a refetch (e.g. on window focus) returns the same reference for
  // unchanged content. Comparing this sorted, joined signature by value, rather than resetting
  // off `assigned`'s identity, means this effect only fires when the assigned set truly changes.
  //
  // Now that the draft lives in the parent's form state (not local `useState`), this effect's
  // job narrows to seeding: when the draft is still empty (`defaultValues: { warehouseIds: [] }`
  // before the load effect's `reset()` has populated it, or simply a fresh create), populate it
  // from the server's assigned set once that becomes known. It never fires once `value` is
  // non-empty, so it can never clobber a selection the user (or the parent's own reset()) has
  // already made — the same bug this effect always guarded against, just guarded a different
  // way now that there is no local `selected` state left to protect.
  const assignedSignature = useMemo(() => assigned.map((w) => w.id).sort().join(","), [assigned]);
  useEffect(() => {
    if (value.length === 0 && assignedSignature) onChange(assignedSignature.split(","));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedSignature]);

  const options = new Map<string, WarehouseDto>();
  for (const w of unassigned.data?.items ?? []) options.set(w.id, w);
  for (const w of assigned) options.set(w.id, w);
  const sorted = [...options.values()].sort((a, b) => a.name.localeCompare(b.name));

  const total = unassigned.data?.total ?? 0;
  const shown = unassigned.data?.items.length ?? 0;
  const truncated = shown < total;

  const selected = new Set(value);

  function toggle(id: string) {
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <section aria-label="Warehouses" className="space-y-4">
      <h2 className="font-display text-lg font-semibold tracking-tight">Warehouses</h2>
      <div className="space-y-1">
        <Label htmlFor="warehouse-search">Search warehouses by name</Label>
        <Input
          id="warehouse-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name"
        />
      </div>
      {truncated && (
        <p className="text-sm text-muted-foreground">
          Showing {shown} of {total} unassigned warehouses — refine by name.
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
    </section>
  );
}
