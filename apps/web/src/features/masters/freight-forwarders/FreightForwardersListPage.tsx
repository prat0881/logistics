import { useState } from "react";
import { Link } from "react-router-dom";
import { useCanWrite } from "@/features/auth/useCanWrite";
import { ApiError } from "@/lib/api";
import { useFreightForwarders } from "../useMasters";
import { Input } from "@/components/ui/input";
import { PaginationBar } from "@/components/PaginationBar";

export function FreightForwardersListPage() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const canWrite = useCanWrite();
  const { data, isLoading, isError, error: fetchError } = useFreightForwarders({ q, page, pageSize });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">Freight Forwarders</h1>
        {canWrite && (
          <Link
            to="/masters/freight-forwarders/new"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            New freight forwarder
          </Link>
        )}
      </div>
      <Input
        placeholder="Search company, code, PIC, email…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setPage(1); }}
      />
      {isError ? (
        // A failed fetch must never render the same "No freight forwarders yet." message an empty,
        // successfully-loaded list would — that reads as data loss. Mirrors
        // ChargeCatalogueListPage, minus its 403 branch: GET /api/freight-forwarders carries no @Roles
        // gate (any signed-in user may read this list), so a 403 is not a reachable failure
        // here and the server’s own message covers whatever did go wrong.
        <p role="alert" className="text-sm text-destructive">
          {fetchError instanceof ApiError ? fetchError.message : "Could not load freight forwarders."}
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">PIC</th>
                <th className="px-4 py-2 font-medium">Modes</th>
                <th className="px-4 py-2 font-medium">DG</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.length ? (
                data.items.map((f) => (
                  <tr key={f.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2 font-mono tabular-nums text-muted-foreground">{f.freightForwarderCode}</td>
                    <td className="px-4 py-2">
                      <Link to={`/masters/freight-forwarders/${f.id}`} className="font-medium text-primary hover:underline">
                        {f.companyName}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{f.pic}</td>
                    <td className="px-4 py-2">{f.modes.join(", ")}</td>
                    <td className="px-4 py-2 text-muted-foreground">{f.handleDg ? "Yes" : "No"}</td>
                    <td className="px-4 py-2 text-muted-foreground">{f.status}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {q ? "No freight forwarders match your search." : "No freight forwarders yet."}
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
