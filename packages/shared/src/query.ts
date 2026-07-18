import { z } from "zod";
import type { Finding } from "./findings";

export const Priority = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH", URGENT: "URGENT" } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];
export const PRIORITIES = Object.values(Priority) as [Priority, ...Priority[]];

// §7.2 — fixed 11-value Incoterms enum.
export const Incoterms = {
  EXW: "EXW",
  FCA: "FCA",
  FAS: "FAS",
  FOB: "FOB",
  CFR: "CFR",
  CIF: "CIF",
  CPT: "CPT",
  CIP: "CIP",
  DAP: "DAP",
  DPU: "DPU",
  DDP: "DDP",
} as const;
export type Incoterms = (typeof Incoterms)[keyof typeof Incoterms];
export const INCOTERMS = Object.values(Incoterms) as [Incoterms, ...Incoterms[]];

export const FileKind = { MSDS: "MSDS" } as const;
export type FileKind = (typeof FileKind)[keyof typeof FileKind];
export const FILE_KINDS = Object.values(FileKind) as [FileKind, ...FileKind[]];

const isoDate = z.string().datetime({ offset: true });

// Draft save (POST /queries, PATCH /queries/:id). Lenient: every field optional so a
// Draft persists with no completeness gate (§13); formats validated WHEN present (F2/F3/F4).
// The full mandatory gate is collectCreateFindings, run only at Create Query.
export const querySaveSchema = z
  .object({
    priority: z.enum(PRIORITIES),
    queryDate: isoDate, // Admin-only backdate, enforced in the service
    responseDeadline: isoDate,
    responseDeadlineRemarks: z.string().max(200),
    clientId: z.string().uuid(),
    contactName: z.string().min(1).max(160),
    contactDesignation: z.string().max(120),
    contactEmail: z.string().email(), // F2
    contactPhone: z.string().regex(/^\+?[1-9]\d{6,14}$/, "Phone must be E.164"), // F2
    whatsappEnabled: z.boolean(),
    faxNumber: z.string().max(40),
    vesselId: z.string().uuid(),
    vesselName: z.string().max(200),
    imoNumber: z.string().regex(/^\d{7}$/, "IMO must be 7 digits"), // F2
    eta: isoDate,
    etb: isoDate,
    etd: isoDate,
    portOfCall: z.string().max(160),
    incoterms: z.enum(INCOTERMS),
    shipmentDescription: z.string().max(200),
    dgIndicator: z.boolean(),
    readyDate: isoDate,
    targetDelivery: isoDate,
    internalNotes: z.string().max(500),
    assignedUserId: z.string().uuid(),
  })
  .partial()
  // F3: ETA < ETB < ETD when all present.
  .refine((q) => !(q.eta && q.etb) || q.eta < q.etb, {
    message: "ETA must be before ETB",
    path: ["eta"],
  })
  .refine((q) => !(q.etb && q.etd) || q.etb < q.etd, {
    message: "ETB must be before ETD",
    path: ["etb"],
  });
export type QuerySaveInput = z.infer<typeof querySaveSchema>;

export const checklistPatchSchema = z.object({
  items: z.array(z.object({ itemKey: z.string().min(1), checked: z.boolean() })).min(1),
});
export type ChecklistPatchInput = z.infer<typeof checklistPatchSchema>;

export interface ChecklistItemStateDto {
  itemKey: string;
  checked: boolean;
}

// ── Create-phase field/cargo validation (§10.1 F1/F5/F6) ────────────────────────
// Pure + isomorphic (reused by the Plan-6 wizard). Route rules R1–R9 + temporal T1–T3
// need legs → Plan 5; NOT included here.
export interface QueryForValidation {
  id: string;
  clientId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  readyDate: Date | string | null;
  targetDelivery: Date | string | null;
  incoterms: Incoterms | null;
}
export interface CargoForValidation {
  id: string;
  isDangerous: boolean;
  msdsFileId: string | null;
  poReference: string;
}

export function collectCreateFindings(
  q: QueryForValidation,
  cargo: CargoForValidation[],
): Finding[] {
  const findings: Finding[] = [];
  const need = (present: unknown, message: string) => {
    if (present === null || present === undefined || present === "") {
      findings.push({
        rule: "F1",
        severity: "blocking",
        scope: { type: "query", id: q.id },
        message,
      });
    }
  };
  need(q.clientId, "Client is required");
  need(q.contactName, "Contact person is required");
  need(q.contactEmail, "Contact email is required");
  need(q.contactPhone, "Contact phone is required");
  need(q.readyDate, "Ready Date is required");
  need(q.targetDelivery, "Target Delivery is required");
  need(q.incoterms, "Incoterms is required");
  for (const c of cargo) {
    if (c.isDangerous && !c.msdsFileId) {
      findings.push({
        rule: "F6",
        severity: "blocking",
        scope: { type: "cargo", id: c.id },
        message: `Cargo ${c.poReference}: a dangerous-goods row requires an MSDS (PDF)`,
      });
    }
  }
  return findings;
}

export interface QueryDto {
  id: string;
  queryCode: string;
  queryDate: string;
  priority: Priority;
  status: string;
  dgIndicator: boolean;
  // …snapshot + shipment fields returned as-is from Prisma (dates ISO strings).
}
