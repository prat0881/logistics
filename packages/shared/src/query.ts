import { z } from "zod";
import type { Finding } from "./findings";
import { QUERY_STATUSES } from "./status";
import { FREIGHT_MODES } from "./config";
import type { FreightMode } from "./config";
import type { LegStatus } from "./status";
import type { LegExecutionStatus } from "./legs";
import type { CargoDto } from "./cargo";
import { isValidIanaZone } from "./timezone";

export const Priority = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH", URGENT: "URGENT" } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];
export const PRIORITIES = Object.values(Priority) as [Priority, ...Priority[]];

/**
 * Response-Deadline default by priority (Round-1 Common Rules / Step-1).
 * Deadline = Query Date + N hours. Recompute-until-touched wiring lives in the wizard.
 * NOTE: pure instant math (base + N h). Timezone-anchored display + the "≥ Query Date"
 * real-instant comparison are the separate timezone increment — not here.
 */
export const RESPONSE_DEADLINE_HOURS: Record<Priority, number> = {
  LOW: 48,
  MEDIUM: 24,
  HIGH: 18,
  URGENT: 12,
};
export function defaultResponseDeadline(queryDate: string, priority: Priority): string {
  const ms = new Date(queryDate).getTime() + RESPONSE_DEADLINE_HOURS[priority] * 3_600_000;
  return new Date(ms).toISOString();
}

// §7.2 — fixed 12-value Incoterms enum (NA stored without slash; display via incotermsLabel).
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
  NA: "NA",
} as const;
export type Incoterms = (typeof Incoterms)[keyof typeof Incoterms];
export const INCOTERMS = Object.values(Incoterms) as [Incoterms, ...Incoterms[]];

/** Returns "N/A" for the NA enum value; returns the value unchanged for all other Incoterms. */
export function incotermsLabel(v: Incoterms): string {
  return v === "NA" ? "N/A" : v;
}

export const FileKind = { MSDS: "MSDS" } as const;
export type FileKind = (typeof FileKind)[keyof typeof FileKind];
export const FILE_KINDS = Object.values(FileKind) as [FileKind, ...FileKind[]];

const isoDate = z.string().datetime({ offset: true });

// Draft save (POST /queries, PATCH /queries/:id). Lenient: every field optional so a
// Draft persists with no completeness gate (§13); formats validated WHEN present:
//   F2 — email / E.164 phone / 7-digit IMO formats (§10.1).
//   F3 — ETA < ETB < ETD when present, incl. the ETA < ETD guard so an absent ETB
//        can't hide an ETD before ETA.
//   F4 — Response Deadline not in the past (date-only, compared to the start of today).
// F1 mandatory-presence is enforced by collectCreateFindings, run only at Create Query —
// not here.
export const querySaveSchema = z
  .object({
    priority: z.enum(PRIORITIES),
    queryDate: isoDate, // Admin-only backdate, enforced in the service
    responseDeadline: isoDate,
    responseDeadlineRemarks: z.string().max(200),
    clientId: z.string().uuid(),
    contactName: z.string().trim().min(1).max(160),
    contactDesignation: z.string().max(120),
    contactEmail: z.string().email(), // F2
    contactPhone: z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164"), // F2 (strict — leading + required)
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
    readyDateTimezone: z.string().refine(isValidIanaZone, { message: "Must be a valid IANA timezone" }),
    targetDeliveryTimezone: z.string().refine(isValidIanaZone, { message: "Must be a valid IANA timezone" }),
    internalNotes: z.string().max(500),
    assignedUserId: z.string().uuid(),
  })
  .partial()
  // F3: ETA < ETB < ETD when present (real-instant compare, offset-aware).
  .refine((q) => !(q.eta && q.etb) || new Date(q.eta).getTime() < new Date(q.etb).getTime(), {
    message: "ETA must be before ETB",
    path: ["eta"],
  })
  .refine((q) => !(q.etb && q.etd) || new Date(q.etb).getTime() < new Date(q.etd).getTime(), {
    message: "ETB must be before ETD",
    path: ["etb"],
  })
  // F3 (transitive): ETA < ETD independent of ETB, so an absent ETB can't hide an
  // ETD before ETA (the two pairwise refines above only cover adjacent pairs).
  .refine((q) => !(q.eta && q.etd) || new Date(q.eta).getTime() < new Date(q.etd).getTime(), {
    message: "ETA must be before ETD",
    path: ["eta"],
  })
  // F4: Response Deadline cannot be in the past.
  .refine(
    (q) => {
      if (!q.responseDeadline) return true;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return new Date(q.responseDeadline) >= today;
    },
    { message: "Response Deadline cannot be in the past", path: ["responseDeadline"] },
  )
  // G10: Target Pickup must be on or before Target Delivery (when both are present).
  .refine(
    (q) =>
      !(q.readyDate && q.targetDelivery) ||
      new Date(q.readyDate).getTime() <= new Date(q.targetDelivery).getTime(),
    { message: "Target Pickup must be on or before Target Delivery", path: ["targetDelivery"] },
  );
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
    const missing =
      present === null ||
      present === undefined ||
      (typeof present === "string" && present.trim() === "");
    if (missing) {
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
  need(q.readyDate, "Target Pickup is required");
  need(q.targetDelivery, "Target Delivery is required");
  // Incoterms buckets to the Shipment tab → field-scoped (not the generic query-scoped `need`).
  {
    const v = q.incoterms;
    const missing = v === null || v === undefined || (typeof v === "string" && v.trim() === "");
    if (missing) {
      findings.push({
        rule: "F1",
        severity: "blocking",
        scope: { type: "field", id: "incoterms" },
        message: "Incoterms is required",
      });
    }
  }
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

export interface ChecklistItemForValidation {
  key: string;
  checked: boolean;
  label: string;
}

/**
 * Notes + all-checklist-boxes manual gate (Round-1 Issue 2, Notes & Checklist tab).
 * Pure/isomorphic; run in the Create-Query preview. Every provided box must be
 * checked and internalNotes must be non-empty. No DG-conditional exemption — all
 * boxes are required (the DG-conditional disable is dropped).
 */
export function collectChecklistFindings(
  items: ChecklistItemForValidation[],
  notes: string | null | undefined,
): Finding[] {
  const findings: Finding[] = [];
  for (const it of items) {
    if (!it.checked) {
      findings.push({
        rule: "F7",
        severity: "blocking",
        scope: { type: "field", id: `checklist:${it.key}` },
        message: `${it.label} must be confirmed`,
      });
    }
  }
  if (notes === null || notes === undefined || notes.trim() === "") {
    findings.push({
      rule: "F7",
      severity: "blocking",
      scope: { type: "field", id: "notes" },
      message: "Internal notes are required",
    });
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

// ── Plan-6 list & detail types ────────────────────────────────────────────────

export const queryListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(QUERY_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assignedUserId: z.string().uuid().optional(),
  freightMode: z
    .string()
    .optional()
    .refine(
      (v) =>
        v === undefined ||
        v
          .split(",")
          .map((t) => t.trim())
          .every((t) => (FREIGHT_MODES as readonly string[]).includes(t)),
      {
        message: `freightMode must be a single or comma-separated list of: ${FREIGHT_MODES.join(", ")}`,
      },
    ),       // single value or CSV, each token validated against FREIGHT_MODES
  country: z.string().trim().min(1).optional(),
  dateField: z.enum(["queryDate", "updatedAt"]).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  sort: z.string().optional(),             // "<column>:<asc|desc>"
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
}).refine(
  // G11: dateFrom must be on or before dateTo (when both are present).
  (p) =>
    !(p.dateFrom && p.dateTo) ||
    new Date(p.dateFrom).getTime() <= new Date(p.dateTo).getTime(),
  { message: "dateFrom must be on or before dateTo", path: ["dateTo"] },
);
export type QueryListParams = z.infer<typeof queryListQuerySchema>;

export type QueryListRow = {
  id: string;
  queryCode: string;
  queryDate: string;
  customerName: string | null;
  contactName: string | null;
  shipmentDescription: string | null;
  freightMode: FreightMode[];
  origin: string;
  destination: string;
  responseDeadline: string | null;
  priority: Priority;
  status: (typeof QUERY_STATUSES)[number];
  assignedUserId: string | null;
  assignedUserName: string | null;
  updatedAt: string;
};

export type PointRef = {
  id: string;
  name: string | null;
  city: string | null;
  country: string | null;
};

export type LegRollup = {
  totalPackages: number;
  totalCbm: number;
  totalGrossWt: number;
  totalNetWt: number;
};

export type QueryLegDto = {
  // Every Leg column (shapeQuery spreads `...rest` after removing legCargo)
  id: string;
  tenantId: string | null;
  queryId: string;
  legCode: string;
  legName: string | null;
  originPointId: string | null;
  destinationPointId: string | null;
  mode: FreightMode | null;
  readyDate: string | null;       // DateTime → ISO string in JSON
  targetDelivery: string | null;  // DateTime → ISO string in JSON
  status: LegStatus;
  executionStatus: LegExecutionStatus;
  createdAt: string;
  updatedAt: string;
  // Derived fields added by shapeQuery
  assignedCargoIds: string[];
  rollup: LegRollup;
};

export type QueryPointDto = {
  // Every Point column (QUERY_GRAPH_ARGS uses `points: true` — all columns)
  id: string;
  tenantId: string | null;
  queryId: string;
  type: string;
  name: string | null;
  streetAddress: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  warehouseType: string | null;
  iataCode: string | null;
  icaoCode: string | null;
  unLocode: string | null;
  terminal: string | null;
  timezone: string | null;
  createdAt: string;
  updatedAt: string;
};

export type QueryChecklistItemDto = {
  id: string;
  itemKey: string;
  checked: boolean;
};

export type QueryFileDto = {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  uploadedById: string | null;
  createdAt: string;
};

export type QueryDetail = {
  // Core Query columns
  id: string;
  tenantId: string | null;
  queryCode: string;
  queryDate: string;
  priority: Priority;
  responseDeadline: string | null;
  responseDeadlineRemarks: string | null;
  clientId: string | null;
  contactName: string | null;
  contactDesignation: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  whatsappEnabled: boolean;
  faxNumber: string | null;
  vesselId: string | null;
  vesselName: string | null;
  imoNumber: string | null;
  eta: string | null;
  etb: string | null;
  etd: string | null;
  portOfCall: string | null;
  incoterms: string | null;
  shipmentDescription: string | null;
  dgIndicator: boolean;
  readyDate: string | null;
  targetDelivery: string | null;
  readyDateTimezone: string | null;
  targetDeliveryTimezone: string | null;
  internalNotes: string | null;
  status: (typeof QUERY_STATUSES)[number];
  rfqReadyAt: string | null;
  assignedUserId: string | null;
  createdAt: string;
  updatedAt: string;
  // Derived-on-read graph
  cargo: CargoDto[];
  checklist: QueryChecklistItemDto[];
  files: QueryFileDto[];
  points: QueryPointDto[];
  legs: QueryLegDto[];
  // Derived summaries
  freightMode: FreightMode[];
  origin: PointRef[];
  destination: PointRef[];
};
