export type Severity = "blocking" | "warning";

export interface FindingScope {
  type: "query" | "leg" | "cargo" | "package" | "point" | "field";
  id?: string;
}

export interface Finding {
  rule: string;
  severity: Severity;
  scope: FindingScope;
  message: string;
}

/** Wizard tab a finding buckets into for the Create-Query Validation Summary. */
export type FindingTab = "client" | "shipment" | "cargo" | "legs" | "notes";

/**
 * Bucket a Finding to a wizard tab (Round-1 Issue 2). Uses scope + rule only.
 * - cargo/F6 → cargo; leg|point → legs; field/incoterms → shipment;
 *   field/notes|checklist → notes; query-scoped: F1 (field-mandatory) → client,
 *   otherwise (route rule) → legs.
 */
export function findingTabKey(f: Finding): FindingTab {
  if (f.scope.type === "cargo" || f.rule === "F6") return "cargo";
  if (f.scope.type === "leg" || f.scope.type === "point") return "legs";
  if (f.scope.type === "field") {
    if (f.scope.id === "incoterms") return "shipment";
    if (f.scope.id === "notes" || f.scope.id?.startsWith("checklist")) return "notes";
  }
  if (f.scope.type === "query") return f.rule === "F1" ? "client" : "legs";
  return "client";
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
