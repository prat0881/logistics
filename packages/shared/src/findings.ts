export type Severity = "blocking" | "warning";

export interface FindingScope {
  type: "query" | "leg" | "cargo" | "point" | "field";
  id?: string;
}

export interface Finding {
  rule: string;
  severity: Severity;
  scope: FindingScope;
  message: string;
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const k = `${f.rule}|${f.severity}|${f.scope.type}|${f.scope.id ?? ""}|${f.message}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}
