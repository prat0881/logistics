import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { fetchJson } from "@/lib/api";

export function HealthStatus() {
  const api = useQuery({
    queryKey: ["health"],
    queryFn: () => fetchJson<{ status: string }>("/api/health"),
  });
  const db = useQuery({
    queryKey: ["health-db"],
    queryFn: () => fetchJson<{ db: string }>("/api/health/db"),
  });

  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">Svyft Logistics</h1>
      <div className="flex items-center gap-2">
        <span>API:</span>
        <Badge variant={api.data?.status === "ok" ? "success" : "destructive"}>
          {api.isLoading ? "…" : (api.data?.status ?? "error")}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <span>DB:</span>
        <Badge variant={db.data?.db === "ok" ? "success" : "destructive"}>
          {db.isLoading ? "…" : (db.data?.db ?? "error")}
        </Badge>
      </div>
    </div>
  );
}
