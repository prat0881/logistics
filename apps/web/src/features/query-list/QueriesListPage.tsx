import { useState, useCallback, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import type { QueryListParams } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PaginationBar } from "@/components/PaginationBar";
import { useQueries } from "./useQueries";
import { makeQueryColumns } from "./columns";
import { QueriesToolbar } from "./QueriesToolbar";
import { useOrgTimezone } from "@/features/config/useOrgTimezone";

/** Query-domain sortable columns (server-side allowlist lives here, not in DataTable). */
const SORTABLE_COLS: string[] = [
  "queryCode",
  "queryDate",
  "responseDeadline",
  "priority",
  "status",
  "updatedAt",
];

const DEFAULT_PARAMS: QueryListParams = {
  page: 1,
  pageSize: 10,
  sort: "updatedAt:desc",
};

export function QueriesListPage() {
  const navigate = useNavigate();
  const [params, setParams] = useState<QueryListParams>(DEFAULT_PARAMS);

  const { orgZone } = useOrgTimezone();
  const columns = useMemo(() => makeQueryColumns(orgZone), [orgZone]);

  const { data, isLoading } = useQueries(params);

  const total = data?.total ?? 0;

  const handleToolbarChange = useCallback((partial: Partial<QueryListParams>) => {
    setParams((prev) => ({ ...prev, ...partial, page: 1 }));
  }, []);

  const handleSortChange = useCallback(
    (col: string) => {
      setParams((prev) => {
        const [currentCol, currentDir] = (prev.sort ?? "updatedAt:desc").split(":");
        const newDir =
          currentCol === col ? (currentDir === "asc" ? "desc" : "asc") : "asc";
        return { ...prev, sort: `${col}:${newDir}`, page: 1 };
      });
    },
    [],
  );

  const currentPage = params.page ?? 1;

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">Queries</h1>
        <Button asChild>
          <Link to="/queries/new">+ Create Query</Link>
        </Button>
      </div>

      {/* Toolbar */}
      <QueriesToolbar onChange={handleToolbarChange} />

      {/* Table */}
      <DataTable
        columns={columns}
        data={data?.items ?? []}
        isLoading={isLoading}
        onRowClick={(row) => navigate(`/queries/${row.id}`)}
        sort={params.sort}
        onSortChange={handleSortChange}
        sortableColumns={SORTABLE_COLS}
        emptyMessage="No queries found. Adjust your filters or create a query to get started."
      />

      {/* Pagination */}
      <PaginationBar
        page={currentPage}
        pageSize={params.pageSize ?? 10}
        total={total}
        onPageChange={(p) => setParams((prev) => ({ ...prev, page: p }))}
        onPageSizeChange={(size) => setParams((prev) => ({ ...prev, pageSize: size, page: 1 }))}
      />
    </div>
  );
}
