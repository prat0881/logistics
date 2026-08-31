import { Link } from "react-router-dom";
import { viewerZone, formatInZone } from "@svyft/shared";
import { useCanWrite } from "@/features/auth/useCanWrite";
import { useFxRatesList } from "./useFxRates";

export function FxRatesPage() {
  const canWrite = useCanWrite();
  const { data, isLoading } = useFxRatesList();
  const zone = viewerZone();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">FX Rates</h1>
        {canWrite && (
          <Link
            to="/masters/fx-rates/new"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            New FX rate
          </Link>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Currency</th>
                <th className="px-4 py-2 font-medium">Units/USD</th>
                <th className="px-4 py-2 font-medium">Effective from</th>
                <th className="px-4 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {data?.length ? (
                data.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2 font-medium">{r.currency}</td>
                    <td className="px-4 py-2 font-mono tabular-nums text-muted-foreground">
                      {r.unitsPerUsd}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {formatInZone(r.effectiveFrom, zone)}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{r.note ?? "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No FX rates yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
