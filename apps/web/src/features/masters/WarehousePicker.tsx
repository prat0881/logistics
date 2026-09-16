import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Paginated, WarehouseDto, WarehouseMasterType } from "@svyft/shared";
import { fetchJson } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { masterErrorMessage } from "./form";

/**
 * The Warehouse master type each owner may draw from. `WarehouseMasterType` is the annotation
 * rather than a bare string so a rename of the enum in `@svyft/shared` fails this file at
 * compile time instead of silently sending a `type` the API filters to nothing.
 */
const OWNER_WAREHOUSE_TYPE: Record<"freight-forwarders" | "clients", WarehouseMasterType> = {
  "freight-forwarders": "FF",
  clients: "CLIENT",
};

/**
 * Owner-agnostic, fully controlled draft editor (Task 8). It no longer talks to the network to
 * save anything — the owning form page's single Save is the only commit point, carrying
 * `warehouseIds` alongside the parent record and its contacts in one request. This component
 * only fetches the *unassigned* pool (`GET /api/warehouses?unassigned=true&type=…`) to offer as
 * checkbox options; toggling a box calls `onChange` with the next id array, exactly like
 * `ContactsSection`'s `value`/`onChange` contract.
 *
 * `assigned` is still a prop, not fetched here — the owning form page reads it (via
 * `useOwnerWarehouses`) so it shares cache with the rest of the page. This component merges the
 * unassigned pool with `assigned` for the checkbox list: a warehouse this owner already has
 * would otherwise vanish from the list the moment it's checked, since ?unassigned=true excludes
 * it.
 *
 * The `type` filter is applied to the pool only, NOT to `assigned`. Warehouse type has been
 * independent of ownership until now, so a record may already hold a warehouse typed
 * OWNED/CONTRACTED; filtering `assigned` too would hide that row while leaving it assigned,
 * stranding a link with no way to remove it from the owner's own form. Merging it in keeps it
 * visible and uncheckable — which also means this component is correct both before and after the
 * one-off cleanup of those mismatched rows.
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
  // The pool a forwarder can draw from is the warehouses tagged FF; a client's is those tagged
  // CLIENT. `type` is ANDed server-side with `unassigned` and `q` (WarehousesService.list), so
  // this narrows the query rather than the fetched page — an OWNED warehouse is now unreachable
  // from either owner form, however it is searched for.
  const type = OWNER_WAREHOUSE_TYPE[ownerPath];
  // The unassigned pool is capped at pageSize=100 (the API's max) and name-ordered, so a
  // warehouse alphabetically past the cap would otherwise be invisible with no hint it exists.
  // `q` re-scopes the *server-side* query rather than filtering the already-fetched 100, so
  // searching actually reaches warehouses outside the initial page. Unlike before Task 8, this
  // is not gated on an ownerId — a brand-new, unsaved record can now assign warehouses too,
  // since nothing commits until the parent's own Save.
  const unassigned = useQuery({
    queryKey: ["warehouses", "unassigned", ownerPath, type, search],
    queryFn: () =>
      fetchJson<Paginated<WarehouseDto>>(
        `/api/warehouses?unassigned=true&type=${type}&pageSize=100&q=${encodeURIComponent(search)}`,
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
  //
  // `value` and `onChange` are deliberately omitted from the dependency array: `value` changes on
  // every toggle and `onChange` is a fresh closure on every parent render, so including either
  // would re-run the seed continuously and defeat the "only when the assigned set truly changes"
  // guarantee above. (No eslint-disable comment here — this repo does not configure
  // eslint-plugin-react-hooks, so the rule name cannot resolve and the comment itself errors.)
  const assignedSignature = useMemo(() => assigned.map((w) => w.id).sort().join(","), [assigned]);
  useEffect(() => {
    if (value.length === 0 && assignedSignature) onChange(assignedSignature.split(","));
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
      {/* A failed fetch must never render the same "No warehouses available to assign." message
          an empty, successfully-loaded pool produces — that reads as "there are none" when the
          truth is "we don't know", and the user would save a selection made against a pool they
          could not see. Same convention as WarehousesListPage's own isError branch. The list
          itself still renders when the merge has anything in it: `assigned` comes from the
          parent's separate query, so an owner's existing warehouses stay visible (and
          uncheckable-by-accident) even when only the unassigned pool failed. */}
      {unassigned.isError && (
        <p role="alert" className="text-sm text-destructive">
          {masterErrorMessage(unassigned.error, "Could not load warehouses to assign.")}
        </p>
      )}
      {sorted.length > 0 ? (
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
      ) : unassigned.isError ? null : (
        <p className="text-sm text-muted-foreground">No warehouses available to assign.</p>
      )}
    </section>
  );
}
