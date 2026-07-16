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
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">Svyft Logistics</h1>
      <div className="flex items-center gap-2">
        <span>API:</span>
        <Badge variant={apiBadge.variant}>{apiBadge.label}</Badge>
      </div>
      <div className="flex items-center gap-2">
        <span>DB:</span>
        <Badge variant={dbBadge.variant}>{dbBadge.label}</Badge>
      </div>
    </div>
  );
}
