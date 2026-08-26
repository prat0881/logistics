import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  CHARGE_CATEGORIES,
  FREIGHT_MODES,
  type ChargeCategory,
  type FreightMode,
} from "@svyft/shared";
import { useCanWrite } from "@/features/auth/useCanWrite";
import { ApiError, del, patchJson } from "@/lib/api";
import { useChargeCatalogueAdmin } from "../useMasters";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const CATEGORY_LABELS: Record<ChargeCategory, string> = {
  ORIGIN: "Origin Charges",
  FREIGHT: "Freight Charges",
  DESTINATION: "Destination Charges",
  ADDITIONAL: "Additional Charges",
};

type StatusFilter = "" | "active" | "inactive";

export function ChargeCatalogueListPage() {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const { data, isLoading, isError, error: fetchError } = useChargeCatalogueAdmin();

  const [q, setQ] = useState("");
  const [mode, setMode] = useState<FreightMode | "">("");
  const [category, setCategory] = useState<ChargeCategory | "">("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // ROAD_WH_HANDLING has no category — warehousing is deferred — so it would render a blank
  // cell in a category-keyed view; it is filtered out here rather than displayed empty.
  const rows = (data ?? [])
    .filter((l) => l.category != null)
    .filter((l) => !mode || l.mode === mode)
    .filter((l) => !category || l.category === category)
    .filter((l) => !status || (status === "active" ? l.isActive : !l.isActive))
    .filter((l) => {
      if (!q) return true;
      const needle = q.toLowerCase();
      return l.label.toLowerCase().includes(needle) || l.key.toLowerCase().includes(needle);
    });

  async function onDeactivate(id: string) {
    setError(null);
    try {
      await patchJson(`/api/charge-line-definitions/${id}`, { isActive: false });
      await qc.invalidateQueries({ queryKey: ["charge-catalogue-admin"] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not deactivate this charge line");
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await del(`/api/charge-line-definitions/${id}`);
      await qc.invalidateQueries({ queryKey: ["charge-catalogue-admin"] });
    } catch (e) {
      // Surfaces the 409 "in use on N legs" message from the API rather than a generic failure.
      setError(e instanceof ApiError ? e.message : "Could not delete this charge line");
    } finally {
      setConfirmDeleteId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">Charge Catalogue</h1>
        {canWrite && (
          <Link
            to="/masters/charge-catalogue/new"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            New charge line
          </Link>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {isError ? (
        // A failed fetch must never render the same "no charge lines" message an empty,
        // successfully-loaded catalogue would — that reads as data loss. A 403 specifically
        // means the signed-in role isn't Administrator/Manager (the only role gate this
        // endpoint enforces); anything else surfaces the server's own message.
        <p role="alert" className="text-sm text-destructive">
          {fetchError instanceof ApiError && fetchError.status === 403
            ? "This screen needs Administrator or Manager access."
            : fetchError instanceof ApiError
              ? fetchError.message
              : "Could not load the charge catalogue."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Input
              placeholder="Search label or key…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="sm:col-span-1"
            />
            <select
              aria-label="Filter by mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as FreightMode | "")}
              className="h-10 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">All modes</option>
              {FREIGHT_MODES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select
              aria-label="Filter by category"
              value={category}
              onChange={(e) => setCategory(e.target.value as ChargeCategory | "")}
              className="h-10 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">All categories</option>
              {CHARGE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
              ))}
            </select>
            <select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="h-10 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Label</th>
                    <th className="px-4 py-2 font-medium">Mode</th>
                    <th className="px-4 py-2 font-medium">Variant</th>
                    <th className="px-4 py-2 font-medium">Category</th>
                    <th className="px-4 py-2 font-medium">Additional</th>
                    <th className="px-4 py-2 font-medium">Input</th>
                    <th className="px-4 py-2 font-medium">Sort</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    {canWrite && <th className="px-4 py-2 font-medium">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? (
                    rows.map((l) => (
                      <tr key={l.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                        <td className="px-4 py-2">
                          {canWrite ? (
                            <Link
                              to={`/masters/charge-catalogue/${l.id}`}
                              className="font-medium text-primary hover:underline"
                            >
                              {l.label}
                            </Link>
                          ) : (
                            <span className="font-medium">{l.label}</span>
                          )}
                          <div className="font-mono text-xs text-muted-foreground">{l.key}</div>
                        </td>
                        <td className="px-4 py-2">{l.mode}</td>
                        <td className="px-4 py-2">{l.variant}</td>
                        <td className="px-4 py-2">{l.category ? CATEGORY_LABELS[l.category] : ""}</td>
                        <td className="px-4 py-2 text-muted-foreground">{l.isAdditional ? "Yes" : "No"}</td>
                        <td className="px-4 py-2 text-muted-foreground">{l.inputType}</td>
                        <td className="px-4 py-2 tabular-nums text-muted-foreground">{l.sortOrder}</td>
                        <td className="px-4 py-2 text-muted-foreground">{l.isActive ? "Active" : "Inactive"}</td>
                        {canWrite && (
                          <td className="px-4 py-2">
                            {confirmDeleteId === l.id ? (
                              <span className="flex gap-2">
                                <span className="text-sm">Delete {l.label}?</span>
                                <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>
                                  Cancel
                                </Button>
                                <Button type="button" variant="destructive" size="sm" onClick={() => void onDelete(l.id)}>
                                  Delete
                                </Button>
                              </span>
                            ) : (
                              <span className="flex gap-2">
                                {l.isActive && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    aria-label={`Deactivate ${l.label}`}
                                    onClick={() => void onDeactivate(l.id)}
                                  >
                                    Deactivate
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Delete ${l.label}`}
                                  onClick={() => setConfirmDeleteId(l.id)}
                                >
                                  Delete
                                </Button>
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={canWrite ? 9 : 8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                        {q || mode || category || status
                          ? "No charge lines match your filters."
                          : "No charge lines yet."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
