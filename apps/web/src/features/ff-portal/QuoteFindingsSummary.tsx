import { dedupeFindings } from "@svyft/shared";
import type { Finding } from "@svyft/shared";
import { findingSection, PORTAL_SECTION_LABEL, PORTAL_SECTION_ORDER } from "./findingNav";
import type { PortalSection } from "./findingNav";

interface QuoteFindingsSummaryProps {
  findings: Finding[];
  onNavigate: (section: PortalSection) => void;
}

export function QuoteFindingsSummary({ findings, onNavigate }: QuoteFindingsSummaryProps) {
  const blocking = dedupeFindings(findings.filter((f) => f.severity === "blocking"));
  if (blocking.length === 0) return null;

  const bySection = new Map<PortalSection, Finding[]>();
  for (const f of blocking) {
    const section = findingSection(f);
    const existing = bySection.get(section);
    if (existing) existing.push(f);
    else bySection.set(section, [f]);
  }

  return (
    <div role="alert" className="space-y-3 rounded-md border border-destructive/30 bg-destructive/10 p-4">
      <p className="text-sm font-semibold text-destructive">
        Resolve {blocking.length} issue{blocking.length === 1 ? "" : "s"} before submitting:
      </p>
      {PORTAL_SECTION_ORDER.filter((s) => bySection.has(s)).map((section) => {
        const items = bySection.get(section)!;
        return (
          <div key={section} className="space-y-1">
            <button
              type="button"
              onClick={() => onNavigate(section)}
              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded-sm"
            >
              {PORTAL_SECTION_LABEL[section]}
              <span className="rounded-full bg-destructive/20 px-1.5 py-0.5 font-mono text-[10px]">{items.length}</span>
            </button>
            <ul className="space-y-0.5 pl-1">
              {items.map((f, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => onNavigate(section)}
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
