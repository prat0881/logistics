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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Clients</h1>
        {canWrite && (
          <Link
            to="/masters/clients/new"
            className="rounded-md bg-slate-900 px-3 py-2 text-sm text-slate-50"
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
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-slate-500">
              <th className="py-2">Code</th>
              <th>Company</th>
              <th>Country</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="py-2">{c.clientCode}</td>
                <td>
                  <Link to={`/masters/clients/${c.id}`} className="underline">
                    {c.companyName}
                  </Link>
                </td>
                <td>{c.country}</td>
                <td>{c.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
