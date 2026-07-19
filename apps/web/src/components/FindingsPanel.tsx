import { dedupeFindings } from "@svyft/shared";
import type { Finding } from "@svyft/shared";
import { cn } from "@/lib/utils";

interface FindingsPanelProps {
  findings: Finding[];
  phase: "draft" | "create";
  onFindingClick?: (finding: Finding) => void;
}

export function FindingsPanel({ findings, onFindingClick }: FindingsPanelProps) {
  const deduped = dedupeFindings(findings);

  if (deduped.length === 0) return null;

  const blocking = deduped.filter((f) => f.severity === "blocking");
  const warnings = deduped.filter((f) => f.severity === "warning");

  return (
    <div className="space-y-2">
      {blocking.map((f, i) => (
        <div
          key={i}
          role="alert"
          className="flex items-start gap-2 rounded-md px-3 py-2 bg-destructive/10 text-destructive"
        >
          <span className={cn("font-mono text-xs shrink-0 mt-0.5")}>{f.rule}</span>
          <span className="flex-1 text-sm">{f.message}</span>
          {(f.scope.id || f.scope.type) && (
            <button
              type="button"
              onClick={() => onFindingClick?.(f)}
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-xs font-mono",
                "bg-destructive/20 hover:bg-destructive/30",
                onFindingClick ? "cursor-pointer" : "cursor-default",
              )}
            >
              {f.scope.type}
              {f.scope.id ? `:${f.scope.id}` : ""}
            </button>
          )}
        </div>
      ))}
      {warnings.map((f, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-md px-3 py-2 bg-warning/10 text-warning"
        >
          <span className={cn("font-mono text-xs shrink-0 mt-0.5")}>{f.rule}</span>
          <span className="flex-1 text-sm">{f.message}</span>
          {(f.scope.id || f.scope.type) && (
            <button
              type="button"
              onClick={() => onFindingClick?.(f)}
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-xs font-mono",
                "bg-warning/20 hover:bg-warning/30",
                onFindingClick ? "cursor-pointer" : "cursor-default",
              )}
            >
              {f.scope.type}
              {f.scope.id ? `:${f.scope.id}` : ""}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
