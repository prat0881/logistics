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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Vessels</h1>
        {canWrite && (
          <Link
            to="/masters/vessels/new"
            className="rounded-md bg-slate-900 px-3 py-2 text-sm text-slate-50"
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
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-slate-500">
              <th className="py-2">Code</th>
              <th>Name</th>
              <th>IMO</th>
              <th>Type</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((v) => (
              <tr key={v.id} className="border-b">
                <td className="py-2">{v.vesselCode}</td>
                <td>
                  <Link to={`/masters/vessels/${v.id}`} className="underline">
                    {v.name}
                  </Link>
                </td>
                <td>{v.imoNumber}</td>
                <td>{v.vesselType}</td>
                <td>{v.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
