import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

/**
 * Generic string type for sortable column identifiers.
 * Call sites are responsible for maintaining their own domain-specific allowlists.
 */
export type SortableColumn = string;

export interface DataTableProps<TData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  onRowClick?: (row: TData) => void;
  isLoading?: boolean;
  className?: string;
  /** Current sort string "<column>:<asc|desc>". Parent drives server-side sort. */
  sort?: string;
  /** Called when user clicks a sortable column header. Toggles asc/desc. */
  onSortChange?: (col: string) => void;
  /** Columns that should render a sort toggle. Defined at the call site. */
  sortableColumns?: string[];
  /** Message shown when there are no rows. Defaults to a no-match message. */
  emptyMessage?: string;
}

const SKELETON_ROWS = 5;

export function DataTable<TData>({
  columns,
  data,
  onRowClick,
  isLoading,
  className,
  sort,
  onSortChange,
  sortableColumns = [],
  emptyMessage = "No results found.",
}: DataTableProps<TData>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Sorting and pagination are server-driven — no internal state.
    manualSorting: true,
    manualPagination: true,
  });

  /** Parse current sort state for a given column key. */
  function getSortDir(colId: string): "asc" | "desc" | null {
    if (!sort) return null;
    const [col, dir] = sort.split(":");
    return col === colId ? (dir as "asc" | "desc") : null;
  }

  function renderSortIcon(colId: string) {
    if (!sortableColumns.includes(colId)) return null;
    const dir = getSortDir(colId);
    if (dir === "asc") return <ChevronUp className="ml-1 inline h-3.5 w-3.5" />;
    if (dir === "desc") return <ChevronDown className="ml-1 inline h-3.5 w-3.5" />;
    return <ChevronsUpDown className="ml-1 inline h-3.5 w-3.5 opacity-40" />;
  }

  return (
    <div className={cn("rounded-md border", className)}>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const isSortable =
                  sortableColumns.includes(header.column.id) && !!onSortChange;
                return (
                  <TableHead
                    key={header.id}
                    onClick={
                      isSortable
                        ? () => onSortChange!(header.column.id)
                        : undefined
                    }
                    className={cn(isSortable && "cursor-pointer select-none hover:text-foreground")}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                    {renderSortIcon(header.column.id)}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {isLoading ? (
            // Loading skeleton rows
            Array.from({ length: SKELETON_ROWS }).map((_, i) => (
              <TableRow key={`skeleton-${i}`}>
                {columns.map((_, j) => (
                  <TableCell key={j}>
                    <div className="h-4 w-full animate-pulse rounded bg-muted" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : table.getRowModel().rows.length > 0 ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                onClick={() => onRowClick?.(row.original)}
                className={cn(
                  onRowClick &&
                    "cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                )}
                // keyboard accessibility: treat as a button when clickable
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row.original);
                        }
                      }
                    : undefined
                }
                role={onRowClick ? "button" : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-24 text-center text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
