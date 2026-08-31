import { useState } from "react";
import { Link } from "react-router-dom";
import { useCanWrite } from "@/features/auth/useCanWrite";
import { ApiError } from "@/lib/api";
import { useWarehouses } from "../useMasters";
import { Input } from "@/components/ui/input";
import { PaginationBar } from "@/components/PaginationBar";

export function WarehousesListPage() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const canWrite = useCanWrite();
  const { data, isLoading, isError, error: fetchError } = useWarehouses({ q, page, pageSize });

  function handleSearch(v: string) { setQ(v); setPage(1); }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">Warehouses</h1>
        {canWrite && (
          <Link
            to="/masters/warehouses/new"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            New warehouse
          </Link>
        )}
      </div>
      <Input
        placeholder="Search name, city, country…"
        value={q}
        onChange={(e) => handleSearch(e.target.value)}
      />
      {isError ? (
        // A failed fetch must never render the same "No warehouses yet." message an empty,
        // successfully-loaded list would — that reads as data loss. Mirrors
        // ChargeCatalogueListPage, minus its 403 branch: GET /api/warehouses carries no @Roles
        // gate (any signed-in user may read this list), so a 403 is not a reachable failure
        // here and the server’s own message covers whatever did go wrong.
        <p role="alert" className="text-sm text-destructive">
          {fetchError instanceof ApiError ? fetchError.message : "Could not load warehouses."}
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">City</th>
                <th className="px-4 py-2 font-medium">Country</th>
                <th className="px-4 py-2 font-medium">Capacity</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.length ? (
                data.items.map((w) => (
                  <tr key={w.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2">
                      <Link
                        to={`/masters/warehouses/${w.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {w.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{w.type}</td>
                    <td className="px-4 py-2">{w.city}</td>
                    <td className="px-4 py-2">{w.country}</td>
                    <td className="px-4 py-2 tabular-nums">{w.capacity} {w.capacityUnit}</td>
                    <td className="px-4 py-2 text-muted-foreground">{w.status}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {q ? "No warehouses match your search." : "No warehouses yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
      />
    </div>
  );
}
