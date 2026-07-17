import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchJson, patchJson } from "@/lib/api";
import type { ChecklistItemDto, DensityFactorDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ConfigPage() {
  const qc = useQueryClient();
  const factors = useQuery({
    queryKey: ["density-factors"],
    queryFn: () => fetchJson<DensityFactorDto[]>("/api/config/density-factors"),
  });
  const checklist = useQuery({
    queryKey: ["checklist"],
    queryFn: () => fetchJson<ChecklistItemDto[]>("/api/config/checklist-definition"),
  });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (v: { mode: string; kgPerCbm: number }) =>
      patchJson(`/api/config/density-factors/${v.mode}`, { kgPerCbm: v.kgPerCbm }),
    onSuccess: async (_data, variables) => {
      await qc.invalidateQueries({ queryKey: ["density-factors"] });
      setEdits((s) => {
        const rest = { ...s };
        delete rest[variables.mode];
        return rest;
      });
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Reference data</h1>
      <section>
        <h2 className="mb-2 font-medium">Freight density factors (kg/CBM)</h2>
        {factors.data?.map((f) => (
          <div key={f.mode} className="flex items-center gap-3 py-1">
            <span className="w-16">{f.mode}</span>
            <Input
              className="w-32"
              value={edits[f.mode] ?? String(f.kgPerCbm)}
              onChange={(e) => setEdits((s) => ({ ...s, [f.mode]: e.target.value }))}
            />
            <Button
              onClick={() =>
                save.mutate({ mode: f.mode, kgPerCbm: Number(edits[f.mode] ?? f.kgPerCbm) })
              }
            >
              Save
            </Button>
          </div>
        ))}
      </section>
      <section>
        <h2 className="mb-2 font-medium">Missing-details checklist</h2>
        <ol className="list-decimal space-y-1 pl-6 text-sm">
          {checklist.data?.map((c) => (
            <li key={c.itemKey}>
              {c.label}
              {c.dgConditional ? " (DG only)" : ""}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
