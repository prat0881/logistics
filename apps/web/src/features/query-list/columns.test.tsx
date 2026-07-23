import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { formatInZone, viewerZone } from "@svyft/shared";
import { makeQueryColumns } from "./columns";
import type { QueryListRow } from "@svyft/shared";

afterEach(() => vi.restoreAllMocks());

const ORG_ZONE = "America/New_York";
const VIEWER_ZONE = viewerZone();

/** Minimal row stub — only date fields matter for this test. */
const makeRow = (overrides: Partial<QueryListRow> = {}): QueryListRow => ({
  id: "q1",
  queryCode: "TST-0001",
  queryDate: "2026-07-15T10:00:00.000Z",
  customerName: "Acme",
  contactName: "Al",
  shipmentDescription: "widgets",
  freightMode: ["SEA"],
  origin: "Mumbai, IN",
  destination: "Rotterdam, NL",
  responseDeadline: "2026-07-22T08:00:00.000Z",
  priority: "HIGH",
  status: "DRAFT",
  assignedUserId: null,
  assignedUserName: "Exec",
  updatedAt: "2026-07-15T12:00:00.000Z",
  ...overrides,
});

/**
 * Render a single cell by finding the column with `accessorKey === key`
 * and calling its `cell` renderer with a mock `getValue`.
 */
function renderCell(
  columns: ReturnType<typeof makeQueryColumns>,
  accessorKey: string,
  value: unknown,
): string {
  const col = columns.find(
    // ColumnDef stores accessorKey as a plain string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => c.accessorKey === accessorKey,
  ) as { cell?: (ctx: { getValue: () => unknown }) => React.ReactNode } | undefined;

  if (!col?.cell) throw new Error(`No cell renderer found for accessorKey="${accessorKey}"`);

  const ctx = { getValue: () => value };
  const { container } = render(<>{col.cell(ctx)}</>);
  return container.textContent ?? "";
}

describe("makeQueryColumns factory", () => {
  it("queryDate cell renders in viewer zone with zone label", () => {
    const columns = makeQueryColumns(ORG_ZONE);
    const iso = "2026-07-15T10:00:00.000Z";
    const text = renderCell(columns, "queryDate", iso);

    const expected = formatInZone(iso, VIEWER_ZONE);
    expect(text).toBe(expected);
    // Zone label is present (e.g. "GMT+5:30", "EDT", etc.)
    expect(text).toMatch(/[A-Z]{2,5}[+-]?\d*:?\d*|GMT[+-]\d/);
  });

  it("updatedAt cell renders in viewer zone with zone label", () => {
    const columns = makeQueryColumns(ORG_ZONE);
    const iso = "2026-07-15T12:00:00.000Z";
    const text = renderCell(columns, "updatedAt", iso);

    const expected = formatInZone(iso, VIEWER_ZONE);
    expect(text).toBe(expected);
    expect(text).toMatch(/[A-Z]{2,5}[+-]?\d*:?\d*|GMT[+-]\d/);
  });

  it("responseDeadline cell renders in org zone (NOT viewer zone) when different", () => {
    const columns = makeQueryColumns(ORG_ZONE);
    const iso = "2026-07-22T08:00:00.000Z";
    const text = renderCell(columns, "responseDeadline", iso);

    const expectedOrgZone = formatInZone(iso, ORG_ZONE);
    expect(text).toBe(expectedOrgZone);
  });

  it("responseDeadline cell shows '—' when value is null", () => {
    const columns = makeQueryColumns(ORG_ZONE);
    const text = renderCell(columns, "responseDeadline", null);
    expect(text).toBe("—");
  });

  it("responseDeadline cell shows '—' when value is empty string", () => {
    const columns = makeQueryColumns(ORG_ZONE);
    const text = renderCell(columns, "responseDeadline", "");
    expect(text).toBe("—");
  });
});
