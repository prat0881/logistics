export function formatQueryCode(year: number, seq: number): string {
  const yy = String(year % 100).padStart(2, "0");
  const nnnn = String(seq).padStart(4, "0");
  return `YAL${yy}-${nnnn}`;
}

export function formatRfqNumber(queryCode: string, seq: number): string {
  return `${queryCode}-RFQ${String(seq).padStart(3, "0")}`;
}
