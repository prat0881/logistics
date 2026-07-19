import { useState } from "react";
import { Link } from "react-router-dom";
import { Role } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { useVessels } from "../useMasters";
import { Input } from "@/components/ui/input";

export function VesselsListPage() {
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const canWrite = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;
  const { data, isLoading } = useVessels(q);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">Vessels</h1>
        {canWrite && (
          <Link
            to="/masters/vessels/new"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            New vessel
          </Link>
        )}
      </div>
      <Input
        placeholder="Search name, code, IMO…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">IMO</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((v) => (
                <tr key={v.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                  <td className="px-4 py-2 font-mono text-muted-foreground">{v.vesselCode}</td>
                  <td className="px-4 py-2">
                    <Link
                      to={`/masters/vessels/${v.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {v.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono tabular-nums text-muted-foreground">
                    {v.imoNumber}
                  </td>
                  <td className="px-4 py-2">{v.vesselType}</td>
                  <td className="px-4 py-2 text-muted-foreground">{v.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
