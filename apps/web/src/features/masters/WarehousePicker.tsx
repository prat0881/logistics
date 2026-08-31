import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Paginated, WarehouseDto } from "@svyft/shared";
import { ApiError, fetchJson, putJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** useMasters.ts's singular-owner query keys, so a save can refresh the owner's own record
 * (e.g. FreightForwarderFormPage's cached `whLocation`, which the save just changed server-side)
 * without this owner-agnostic component needing to know each owner's DTO shape. */
const OWNER_SINGULAR: Record<"freight-forwarders" | "clients", string> = {
  "freight-forwarders": "freight-forwarder",
  clients: "client",
};

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
  const [search, setSearch] = useState("");
  // The unassigned pool is capped at pageSize=100 (the API's max) and name-ordered, so a
  // warehouse alphabetically past the cap would otherwise be invisible with no hint it exists.
  // `q` re-scopes the *server-side* query rather than filtering the already-fetched 100, so
  // searching actually reaches warehouses outside the initial page.
  const unassigned = useQuery({
    queryKey: ["warehouses", "unassigned", search],
    queryFn: () =>
      fetchJson<Paginated<WarehouseDto>>(
        `/api/warehouses?unassigned=true&pageSize=100&q=${encodeURIComponent(search)}`,
      ),
    enabled: Boolean(ownerId),
  });

  const [selected, setSelected] = useState<Set<string>>(() => new Set(assigned.map((w) => w.id)));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // A stable, content-based signature rather than `assigned`'s own array identity. The parent
  // hands us `ownedWarehouses.data ?? []` — while that query is loading, `?? []` allocates a
  // brand-new empty array on *every* render (not just on real data changes), and even once
  // loaded, nothing guarantees a refetch (e.g. on window focus) returns the same reference for
  // unchanged content. Resetting `selected` off `assigned`'s identity would then silently
  // discard whatever the user had just checked, on a render that has nothing to do with the
  // assignment actually changing. Comparing this sorted, joined signature by value instead means
  // `selected` only resets when the assigned set truly changes.
  const assignedSignature = useMemo(() => assigned.map((w) => w.id).sort().join(","), [assigned]);
  useEffect(() => {
    setSelected(new Set(assignedSignature ? assignedSignature.split(",") : []));
  }, [assignedSignature]);

  if (!ownerId) {
    return <p className="text-sm text-muted-foreground">Save this record before assigning warehouses.</p>;
  }

  const options = new Map<string, WarehouseDto>();
  for (const w of unassigned.data?.items ?? []) options.set(w.id, w);
  for (const w of assigned) options.set(w.id, w);
  const sorted = [...options.values()].sort((a, b) => a.name.localeCompare(b.name));

  const total = unassigned.data?.total ?? 0;
  const shown = unassigned.data?.items.length ?? 0;
  const truncated = shown < total;

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
        // Prefix match: also catches this component's own ["warehouses","unassigned",search]
        // query (at any search value) and useWarehouses' master list ["warehouses", q, page,
        // pageSize] — a warehouse this save just claimed or released must vanish from, or
        // reappear in, both, not only in this picker's own view.
        qc.invalidateQueries({ queryKey: ["warehouses"] }),
        // Refreshes the owner's own cached record — e.g. FreightForwarderFormPage's read-only
        // `whLocation` field, which this save just changed server-side via setWarehouses.
        qc.invalidateQueries({ queryKey: [OWNER_SINGULAR[ownerPath], ownerId] }),
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
      <Button type="button" onClick={onSave} disabled={isSaving}>
        {isSaving ? "Saving…" : "Save warehouses"}
      </Button>
    </section>
  );
}
