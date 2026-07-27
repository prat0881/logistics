import { describe, it, expect } from "vitest";
import type { QueryLegDto } from "@svyft/shared";
import { computeCargoConflicts } from "./cargoConflicts";

const leg = (over: Partial<QueryLegDto>): QueryLegDto =>
  ({
    id: "l",
    legCode: "L",
    originPointId: null,
    destinationPointId: null,
    assignedCargoIds: [],
    mode: null,
    readyDate: null,
    targetDelivery: null,
    ...over,
  }) as QueryLegDto;

describe("computeCargoConflicts", () => {
  it("flags a cargo already leaving the same origin on another leg (fork / parallel drop)", () => {
    const legs = [
      leg({ id: "l1", legCode: "L1", originPointId: "pu", destinationPointId: "d1", assignedCargoIds: ["c1"] }),
    ];
    // editing a NEW leg pu -> d2 (same pickup, different drop) → parallel drop
    const conflicts = computeCargoConflicts(legs, { originPointId: "pu", destinationPointId: "d2" });
    expect(conflicts.get("c1")).toBe("L1");
  });

  it("flags a cargo already arriving at the same destination on another leg (merge)", () => {
    const legs = [
      leg({ id: "l1", legCode: "L1", originPointId: "p1", destinationPointId: "de", assignedCargoIds: ["c1"] }),
    ];
    const conflicts = computeCargoConflicts(legs, { originPointId: "p2", destinationPointId: "de" });
    expect(conflicts.get("c1")).toBe("L1");
  });

  it("does NOT flag a valid sequential chain (one leg's destination = the next leg's origin)", () => {
    const legs = [
      leg({ id: "l1", legCode: "L1", originPointId: "pu", destinationPointId: "wh", assignedCargoIds: ["c1"] }),
    ];
    // editing L2 wh -> de: shares wh, but as L2.origin = L1.destination (sequential) — allowed
    const conflicts = computeCargoConflicts(legs, { id: "l2", originPointId: "wh", destinationPointId: "de" });
    expect(conflicts.has("c1")).toBe(false);
  });

  it("excludes the leg being edited (its own cargo is not a self-conflict)", () => {
    const legs = [
      leg({ id: "l1", legCode: "L1", originPointId: "pu", destinationPointId: "d1", assignedCargoIds: ["c1"] }),
    ];
    const conflicts = computeCargoConflicts(legs, { id: "l1", originPointId: "pu", destinationPointId: "d1" });
    expect(conflicts.has("c1")).toBe(false);
  });

  it("returns empty when the edited leg has neither origin nor destination yet", () => {
    const legs = [
      leg({ id: "l1", legCode: "L1", originPointId: "pu", destinationPointId: "d1", assignedCargoIds: ["c1"] }),
    ];
    const conflicts = computeCargoConflicts(legs, { originPointId: null, destinationPointId: null });
    expect(conflicts.size).toBe(0);
  });

  it("reports the first conflicting leg code when several parallel legs carry the cargo", () => {
    const legs = [
      leg({ id: "l1", legCode: "L1", originPointId: "pu", destinationPointId: "d1", assignedCargoIds: ["c1"] }),
      leg({ id: "l2", legCode: "L2", originPointId: "pu", destinationPointId: "d2", assignedCargoIds: ["c1"] }),
    ];
    const conflicts = computeCargoConflicts(legs, { originPointId: "pu", destinationPointId: "d3" });
    expect(conflicts.get("c1")).toBe("L1");
  });
});
