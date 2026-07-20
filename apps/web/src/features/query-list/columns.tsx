import type { ColumnDef } from "@tanstack/react-table";
import type { QueryListRow, FreightMode } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatDate } from "@/lib/dates";

// Badge variant helpers
function priorityVariant(p: string): "destructive" | "warning" | "secondary" | "outline" {
  if (p === "URGENT") return "destructive";
  if (p === "HIGH") return "warning";
  if (p === "MEDIUM") return "secondary";
  return "outline";
}

function statusVariant(
  s: string,
): "pending" | "secondary" | "default" | "success" | "accent" | "outline" {
  if (s === "DRAFT") return "pending";
  if (s === "CREATED") return "secondary";
  if (s === "RFQ_READY") return "default";
  if (s === "RFQ_SENT") return "accent";
  if (s === "QUOTED") return "success";
  if (s === "WON") return "success";
  if (s === "LOST") return "destructive" as "outline";
  if (s === "CLOSED") return "outline";
  return "outline";
}

function freightModeVariant(mode: FreightMode): "default" | "secondary" | "accent" {
  if (mode === "SEA") return "default";
  if (mode === "AIR") return "secondary";
  return "accent";
}

function truncate(s: string | null, len = 40): string {
  if (!s) return "";
  return s.length > len ? s.slice(0, len) + "…" : s;
}

export const queryColumns: ColumnDef<QueryListRow>[] = [
  {
    accessorKey: "queryCode",
    header: "Query Code",
    cell: ({ getValue }) => (
      <span className="font-mono tabular-nums text-primary">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: "queryDate",
    header: "Query Date",
    cell: ({ getValue }) => (
      <span className="font-mono tabular-nums text-muted-foreground">
        {formatDateTime(getValue<string>())}
      </span>
    ),
  },
  {
    accessorKey: "customerName",
    header: "Customer",
    cell: ({ getValue }) => <span>{getValue<string | null>() ?? "—"}</span>,
  },
  {
    accessorKey: "contactName",
    header: "Contact",
    cell: ({ getValue }) => <span>{getValue<string | null>() ?? "—"}</span>,
  },
  {
    accessorKey: "shipmentDescription",
    header: "Shipment",
    cell: ({ getValue }) => {
      const val = getValue<string | null>();
      const truncated = truncate(val);
      return (
        <span title={val ?? ""} className="block max-w-[200px] truncate">
          {truncated || "—"}
        </span>
      );
    },
  },
  {
    accessorKey: "freightMode",
    header: "Mode",
    cell: ({ getValue }) => {
      const modes = getValue<FreightMode[]>();
      if (!modes || modes.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {modes.map((m) => (
            <Badge key={m} variant={freightModeVariant(m)}>
              {m}
            </Badge>
          ))}
        </div>
      );
    },
  },
  {
    accessorKey: "origin",
    header: "Origin",
    cell: ({ getValue }) => <span>{getValue<string>() || "—"}</span>,
  },
  {
    accessorKey: "destination",
    header: "Destination",
    cell: ({ getValue }) => <span>{getValue<string>() || "—"}</span>,
  },
  {
    accessorKey: "responseDeadline",
    header: "Response By",
    cell: ({ getValue }) => (
      <span className="font-mono tabular-nums text-muted-foreground">
        {formatDate(getValue<string | null>()) || "—"}
      </span>
    ),
  },
  {
    accessorKey: "priority",
    header: "Priority",
    cell: ({ getValue }) => {
      const p = getValue<string>();
      return <Badge variant={priorityVariant(p)}>{p}</Badge>;
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }) => {
      const s = getValue<string>();
      return <Badge variant={statusVariant(s)}>{s.replace(/_/g, " ")}</Badge>;
    },
  },
  {
    accessorKey: "assignedUserName",
    header: "Assigned To",
    cell: ({ getValue }) => <span>{getValue<string | null>() ?? "—"}</span>,
  },
  {
    accessorKey: "updatedAt",
    header: "Updated",
    cell: ({ getValue }) => (
      <span className="font-mono tabular-nums text-muted-foreground">
        {formatDateTime(getValue<string>())}
      </span>
    ),
  },
];
