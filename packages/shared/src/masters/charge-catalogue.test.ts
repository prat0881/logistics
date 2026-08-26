import { describe, expect, it } from "vitest";
import { chargeLineCreateSchema, categoriesForMode, deriveRole, deriveZone, chargeVariantsForMode } from "./charge-catalogue";

describe("deriveZone", () => {
  it("maps the three positional categories onto the existing zones for Air and Sea", () => {
    expect(deriveZone("ORIGIN", "AIR")).toBe("ORIGIN");
    expect(deriveZone("FREIGHT", "SEA")).toBe("MAIN_FREIGHT");
    expect(deriveZone("DESTINATION", "AIR")).toBe("DESTINATION");
  });

  it("maps Additional to no zone", () => {
    expect(deriveZone("ADDITIONAL", "AIR")).toBeNull();
  });

  it("gives Road no zone at all, whatever its category", () => {
    // Every Road definition carries zone = null today, ROAD_CORE_TRUCKING included. A Road
    // freight line must keep deriving null, or distribute would freeze MAIN_FREIGHT onto
    // ChargeLine.zone where it previously froze null.
    expect(deriveZone("FREIGHT", "ROAD")).toBeNull();
    expect(deriveZone("ADDITIONAL", "ROAD")).toBeNull();
  });
});

describe("deriveRole", () => {
  it("is CORE when the line is not additional", () => {
    expect(deriveRole(false, null)).toBe("CORE");
  });

  it("is TAG_DRIVEN when additional and carrying a tag", () => {
    expect(deriveRole(true, "DG")).toBe("TAG_DRIVEN");
  });

  it("is STANDARD when additional without a tag", () => {
    expect(deriveRole(true, null)).toBe("STANDARD");
  });

  it("ignores a tag on a non-additional line", () => {
    expect(deriveRole(false, "DG")).toBe("CORE");
  });
});

describe("mode-scoped options", () => {
  it("offers Road only Freight and Additional", () => {
    expect(categoriesForMode("ROAD")).toEqual(["FREIGHT", "ADDITIONAL"]);
  });

  it("offers Air and Sea all four categories", () => {
    expect(categoriesForMode("AIR")).toEqual(["ORIGIN", "FREIGHT", "DESTINATION", "ADDITIONAL"]);
  });

  it("scopes variants to the mode", () => {
    expect(chargeVariantsForMode("ROAD")).toEqual(["DEDICATED", "GROUPAGE", "BOTH"]);
    expect(chargeVariantsForMode("AIR")).toEqual(["DIRECT", "INDIRECT", "BOTH"]);
    expect(chargeVariantsForMode("SEA")).toEqual(["FCL", "LCL", "BOTH"]);
  });
});

describe("chargeLineCreateSchema", () => {
  const base = { mode: "SEA" as const, category: "DESTINATION" as const, variant: "FCL" as const, label: "Devanning", isAdditional: true };

  it("accepts a well-formed line", () => {
    expect(chargeLineCreateSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a variant that belongs to another mode", () => {
    expect(chargeLineCreateSchema.safeParse({ ...base, variant: "DEDICATED" }).success).toBe(false);
  });

  it("rejects Origin on a Road line", () => {
    expect(chargeLineCreateSchema.safeParse({ mode: "ROAD", category: "ORIGIN", variant: "BOTH", label: "x", isAdditional: false }).success).toBe(false);
  });
});
