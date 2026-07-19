import { useQuery } from "@tanstack/react-query";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { fetchJson } from "@/lib/api";

function healthBadge(
  isPending: boolean,
  isError: boolean,
  value: string | undefined,
): { variant: BadgeProps["variant"]; label: string } {
  if (isPending) return { variant: "pending", label: "checking…" };
  if (isError || value !== "ok") return { variant: "destructive", label: "error" };
  return { variant: "success", label: "ok" };
}

export function HealthStatus() {
  const api = useQuery({
    queryKey: ["health"],
    queryFn: () => fetchJson<{ status: string }>("/api/health"),
  });
  const db = useQuery({
    queryKey: ["health-db"],
    queryFn: () => fetchJson<{ db: string }>("/api/health/db"),
  });

  const apiBadge = healthBadge(api.isPending, api.isError, api.data?.status);
  const dbBadge = healthBadge(db.isPending, db.isError, db.data?.db);

  return (
    <div className="max-w-sm space-y-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        System status
      </h2>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">API</span>
        <Badge variant={apiBadge.variant}>{apiBadge.label}</Badge>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">Database</span>
        <Badge variant={dbBadge.variant}>{dbBadge.label}</Badge>
      </div>
    </div>
  );
}
