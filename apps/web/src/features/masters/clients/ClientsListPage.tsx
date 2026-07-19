import { useState } from "react";
import { Link } from "react-router-dom";
import { Role } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { useClients } from "../useMasters";
import { Input } from "@/components/ui/input";

export function ClientsListPage() {
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const canWrite = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;
  const { data, isLoading } = useClients(q);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">Clients</h1>
        {canWrite && (
          <Link
            to="/masters/clients/new"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            New client
          </Link>
        )}
      </div>
      <Input
        placeholder="Search company, code, country…"
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
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Country</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                  <td className="px-4 py-2 font-mono text-muted-foreground">{c.clientCode}</td>
                  <td className="px-4 py-2">
                    <Link
                      to={`/masters/clients/${c.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {c.companyName}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{c.country}</td>
                  <td className="px-4 py-2 text-muted-foreground">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
