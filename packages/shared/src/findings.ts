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
