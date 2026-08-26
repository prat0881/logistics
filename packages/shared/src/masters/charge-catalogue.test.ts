import { describe, expect, it } from "vitest";
import { chargeLineCreateSchema, chargeLineKey, categoriesForMode, deriveRole, deriveZone, chargeVariantsForMode } from "./charge-catalogue";

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

  it("rejects a tag on a non-additional line", () => {
    // Valid against every other rule (real mode/category/variant combo, real tag) — the only
    // thing wrong is isAdditional: false paired with a tagKey, so this exercises exactly the
    // superRefine branch at tagKey/isAdditional and nothing else.
    const result = chargeLineCreateSchema.safeParse({ ...base, isAdditional: false, tagKey: "DG" });
    expect(result.success).toBe(false);
  });

  it("rejects a punctuation-only label", () => {
    // min(1) alone lets "?" or "-" through; a label with no letters or digits at all collapses
    // to an empty key slug (see chargeLineKey tests below), so it must be rejected here instead
    // of producing a degenerate key.
    const result = chargeLineCreateSchema.safeParse({ ...base, label: "?" });
    expect(result.success).toBe(false);
  });
});

describe("chargeLineKey", () => {
  it("builds a key from mode, category and a slugified label", () => {
    expect(chargeLineKey("SEA", "DESTINATION", "Wharfage Charges")).toBe("SEA_DEST_WHARFAGE_CHARGES");
  });

  it("collapses punctuation and runs of whitespace into single underscores", () => {
    expect(chargeLineKey("AIR", "ADDITIONAL", "Handling & Documentation   Fee!!"))
      .toBe("AIR_ADD_HANDLING_DOCUMENTATION_FEE");
  });

  it("does not leave a trailing underscore when truncation lands on a collapsed separator", () => {
    // The 40th character of the slugified label is the underscore standing in for the space —
    // slicing to 40 chars BEFORE stripping boundary underscores must still produce a clean key,
    // not one ending in "_" (the bug: stripping before slicing lets the cut re-expose it).
    const label = "A".repeat(39) + " REST";
    const key = chargeLineKey("SEA", "DESTINATION", label);
    expect(key).toBe(`SEA_DEST_${"A".repeat(39)}`);
    expect(key.endsWith("_")).toBe(false);
  });
});
