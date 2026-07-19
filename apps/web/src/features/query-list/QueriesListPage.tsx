import { useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { QueryListParams } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { DataTable, type SortableColumn } from "@/components/ui/data-table";
import { useQueries } from "./useQueries";
import { queryColumns } from "./columns";
import { QueriesToolbar } from "./QueriesToolbar";

const SORTABLE_COLS: SortableColumn[] = [
  "queryCode",
  "queryDate",
  "responseDeadline",
  "priority",
  "status",
  "updatedAt",
];

const DEFAULT_PARAMS: QueryListParams = {
  page: 1,
  pageSize: 20,
  sort: "updatedAt:desc",
};

export function QueriesListPage() {
  const navigate = useNavigate();
  const [params, setParams] = useState<QueryListParams>(DEFAULT_PARAMS);

  const { data, isLoading } = useQueries(params);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (params.pageSize ?? 20)));

  function handleToolbarChange(partial: Partial<QueryListParams>) {
    setParams((prev) => ({ ...prev, ...partial, page: 1 }));
  }

  const handleSortChange = useCallback(
    (col: SortableColumn) => {
      setParams((prev) => {
        const [currentCol, currentDir] = (prev.sort ?? "updatedAt:desc").split(":");
        const newDir =
          currentCol === col ? (currentDir === "asc" ? "desc" : "asc") : "asc";
        return { ...prev, sort: `${col}:${newDir}`, page: 1 };
      });
    },
    [],
  );

  function prevPage() {
    setParams((p) => ({ ...p, page: Math.max(1, (p.page ?? 1) - 1) }));
  }
  function nextPage() {
    setParams((p) => ({ ...p, page: Math.min(pageCount, (p.page ?? 1) + 1) }));
  }

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
        columns={queryColumns}
        data={data?.items ?? []}
        isLoading={isLoading}
        onRowClick={(row) => navigate(`/queries/${row.id}`)}
        sort={params.sort}
        onSortChange={handleSortChange}
        sortableColumns={SORTABLE_COLS}
      />

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total === 0 ? "No results" : `${total} result${total !== 1 ? "s" : ""}`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={prevPage}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>
            Page {currentPage} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={nextPage}
            disabled={currentPage >= pageCount}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
