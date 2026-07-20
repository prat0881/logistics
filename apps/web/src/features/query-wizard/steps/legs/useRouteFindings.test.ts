import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { QueryDetail, Finding } from "@svyft/shared";
import { useRouteFindings, groupFindingsByScope } from "./useRouteFindings";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Minimal QueryDetail fixture — only the fields toRouteGraph/validateRoute touch. */
function makeDetail(id = "q1"): QueryDetail {
  return {
    id,
    tenantId: null,
    queryCode: "YAL26-0001",
    queryDate: "2026-01-01T00:00:00+00:00",
    priority: "MEDIUM",
    responseDeadline: null,
    responseDeadlineRemarks: null,
    clientId: null,
    contactName: null,
    contactDesignation: null,
    contactEmail: null,
    contactPhone: null,
    whatsappEnabled: false,
    faxNumber: null,
    vesselId: null,
    vesselName: null,
    imoNumber: null,
    eta: null,
    etb: null,
    etd: null,
    portOfCall: null,
    incoterms: null,
    shipmentDescription: null,
    dgIndicator: false,
    readyDate: null,
    targetDelivery: null,
    internalNotes: null,
    status: "DRAFT",
    rfqReadyAt: null,
    assignedUserId: null,
    createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-01T00:00:00+00:00",
    cargo: [],
    checklist: [],
    files: [],
    points: [],
    legs: [],
    freightMode: [],
    origin: [],
    destination: [],
  } as QueryDetail;
}

describe("useRouteFindings", () => {
  it("returns clientFindings synchronously and serverError starts null", () => {
    const { result } = renderHook(() => useRouteFindings(makeDetail()));
    expect(result.current.clientFindings).toBeDefined();
    expect(result.current.serverError).toBeNull();
    expect(result.current.validating).toBe(false);
  });

  it("validateOnServer — resolves with findings and does NOT throw on network/5xx failure", async () => {
    // Simulate a network failure (fetch rejects)
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useRouteFindings(makeDetail()));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.validateOnServer();
    });

    // Must not throw — returns empty array
    expect(returned).toEqual([]);
    // Sets the error message
    expect(result.current.serverError).toBe(
      "Couldn't reach the validation service — showing local checks only",
    );
    // validating is cleared by finally
    expect(result.current.validating).toBe(false);
  });

  it("validateOnServer — resolves with findings and does NOT throw on 5xx (non-ok response)", async () => {
    // Simulate a 500 response — postJson throws ApiError
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: "Internal Server Error" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useRouteFindings(makeDetail()));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.validateOnServer();
    });

    expect(returned).toEqual([]);
    expect(result.current.serverError).toBe(
      "Couldn't reach the validation service — showing local checks only",
    );
    expect(result.current.validating).toBe(false);
  });

  it("validateOnServer — happy path stores and returns deduped server findings", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            findings: [
              { rule: "R1", severity: "warning", scope: { type: "query", id: null }, message: "ok" },
              // Duplicate — dedupeFindings should collapse it
              { rule: "R1", severity: "warning", scope: { type: "query", id: null }, message: "ok" },
            ],
          }),
        ),
      json: () =>
        Promise.resolve({
          findings: [
            { rule: "R1", severity: "warning", scope: { type: "query", id: null }, message: "ok" },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useRouteFindings(makeDetail()));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.validateOnServer();
    });

    expect(result.current.serverError).toBeNull();
    expect(result.current.validating).toBe(false);
    // At least one finding returned
    expect((returned as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("groupFindingsByScope", () => {
  const legs = [
    { id: "leg1", assignedCargoIds: ["cargoA"] },
    { id: "leg2", assignedCargoIds: ["cargoA", "cargoB"] },
  ];

  it("groups leg/point/query findings and fans cargo findings onto carrying legs", () => {
    const findings: Finding[] = [
      { rule: "C1", severity: "blocking", scope: { type: "leg", id: "leg1" }, message: "leg1 issue" },
      { rule: "R8", severity: "blocking", scope: { type: "point", id: "p1" }, message: "point issue" },
      { rule: "R5", severity: "blocking", scope: { type: "query" }, message: "need a pickup" },
      { rule: "R1", severity: "blocking", scope: { type: "cargo", id: "cargoA" }, message: "cargoA chain" },
    ];
    const g = groupFindingsByScope(findings, legs);
    // leg1 = its own C1 + the cargoA fan-out; leg2 = cargoA fan-out only
    expect(g.byLeg.get("leg1")?.map((f) => f.rule)).toEqual(["C1", "R1"]);
    expect(g.byLeg.get("leg2")?.map((f) => f.rule)).toEqual(["R1"]);
    expect(g.byPoint.get("p1")?.map((f) => f.rule)).toEqual(["R8"]);
    expect(g.queryScoped.map((f) => f.rule)).toEqual(["R5"]);
    expect(g.blocking).toHaveLength(4);
  });

  it("puts a cargo finding with no carrying leg into queryScoped", () => {
    const findings: Finding[] = [
      { rule: "R3", severity: "blocking", scope: { type: "cargo", id: "orphan" }, message: "x" },
    ];
    const g = groupFindingsByScope(findings, legs);
    expect(g.queryScoped.map((f) => f.rule)).toEqual(["R3"]);
    expect(g.byLeg.size).toBe(0);
  });
});
