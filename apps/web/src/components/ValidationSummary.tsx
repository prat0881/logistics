import { dedupeFindings, findingTabKey } from "@svyft/shared";
import type { Finding, FindingTab } from "@svyft/shared";

const TAB_ORDER: FindingTab[] = ["client", "shipment", "cargo", "legs", "notes"];
const TAB_LABEL: Record<FindingTab, string> = {
  client: "Client & Query",
  shipment: "Shipment",
  cargo: "Cargo",
  legs: "Leg & Route",
  notes: "Notes & Checklist",
};

interface ValidationSummaryProps {
  findings: Finding[];
  onNavigate: (tab: FindingTab) => void;
}

export function ValidationSummary({ findings, onNavigate }: ValidationSummaryProps) {
  const deduped = dedupeFindings(findings).filter((f) => f.severity === "blocking");
  if (deduped.length === 0) return null;

  const byTab = new Map<FindingTab, Finding[]>();
  for (const f of deduped) {
    const tab = findingTabKey(f);
    const existing = byTab.get(tab);
    if (existing) existing.push(f);
    else byTab.set(tab, [f]);
  }

  return (
    <div role="alert" className="space-y-3 rounded-md border border-destructive/30 bg-destructive/10 p-4">
      <p className="text-sm font-semibold text-destructive">
        Resolve {deduped.length} issue{deduped.length === 1 ? "" : "s"} to create this query:
      </p>
      {TAB_ORDER.filter((t) => byTab.has(t)).map((tab) => {
        const items = byTab.get(tab)!;
        return (
          <div key={tab} className="space-y-1">
            <button
              type="button"
              onClick={() => onNavigate(tab)}
              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded-sm"
            >
              {TAB_LABEL[tab]}
              <span className="rounded-full bg-destructive/20 px-1.5 py-0.5 font-mono text-[10px]">{items.length}</span>
            </button>
            <ul className="space-y-0.5 pl-1">
              {items.map((f, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => onNavigate(tab)}
                    className="text-left text-sm text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded-sm"
                  >
                    {f.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
