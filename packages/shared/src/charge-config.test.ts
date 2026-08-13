import { describe, it, expect } from "vitest";
import { resolveChargeConfig, type ChargeLineDefinitionDto } from "./charge-config";

const def = (
  p: Partial<ChargeLineDefinitionDto> & { key: string; role: ChargeLineDefinitionDto["role"] },
): ChargeLineDefinitionDto => ({
  id: p.key,
  key: p.key,
  mode: "AIR",
  role: p.role,
  inputType: p.inputType ?? "PLAIN",
  zone: p.zone ?? "DESTINATION",
  tagKey: p.tagKey ?? null,
  label: p.label ?? p.key,
  sortOrder: p.sortOrder ?? 0,
  isActive: p.isActive ?? true,
});

describe("resolveChargeConfig", () => {
  const defs = [
    def({ key: "AIR_ORIGIN_THC", role: "CORE", zone: "ORIGIN", sortOrder: 1 }),
    def({ key: "AIR_DEST_THC", role: "STANDARD", zone: "DESTINATION", sortOrder: 2 }),
    def({ key: "AIR_DEST_STORAGE", role: "STANDARD", zone: "DESTINATION", sortOrder: 3 }),
    def({
      key: "AIR_TAG_FRAGILE",
      role: "TAG_DRIVEN",
      zone: "DESTINATION",
      tagKey: "FRAGILE",
      sortOrder: 4,
    }),
    def({
      key: "ROAD_CORE_TRUCKING",
      role: "CORE",
      inputType: "TRUCKING",
      zone: null,
      sortOrder: 0,
    }),
    def({
      key: "ROAD_WH_HANDLING",
      role: "WAREHOUSE",
      inputType: "WAREHOUSE_STAGING",
      zone: null,
      sortOrder: 9,
    }),
  ];

  it("always includes CORE PLAIN lines and excludes unselected optionals", () => {
    const snap = resolveChargeConfig(defs, [], false);
    expect(snap.lines.map((l) => l.definitionKey)).toEqual(["AIR_ORIGIN_THC"]);
    expect(snap.warehouseIncluded).toBe(false);
  });

  it("includes selected STANDARD + TAG_DRIVEN lines, ordered by sortOrder", () => {
    // two-gate: TAG_DRIVEN also needs its tagKey ("FRAGILE") present among packageTags.
    const snap = resolveChargeConfig(defs, ["AIR_DEST_THC", "AIR_TAG_FRAGILE"], true, ["FRAGILE"]);
    expect(snap.lines.map((l) => l.definitionKey)).toEqual([
      "AIR_ORIGIN_THC",
      "AIR_DEST_THC",
      "AIR_TAG_FRAGILE",
    ]);
    expect(snap.warehouseIncluded).toBe(true);
  });

  it("never puts TRUCKING or WAREHOUSE_STAGING lines in the PLAIN snapshot set", () => {
    const snap = resolveChargeConfig(defs, ["ROAD_WH_HANDLING"], true);
    expect(
      snap.lines.some((l) => l.inputType !== "PLAIN" && l.inputType !== "HEAVY_WEIGHT_CALC"),
    ).toBe(false);
  });

  it("activates a tag-driven line only when selected AND a package carries the tag", () => {
    const tagDefs = [
      def({
        key: "AIR_TAG_DG",
        role: "TAG_DRIVEN",
        inputType: "PLAIN",
        tagKey: "DG",
        sortOrder: 16,
      }),
      def({
        key: "AIR_TAG_FRAGILE",
        role: "TAG_DRIVEN",
        inputType: "PLAIN",
        tagKey: "FRAGILE",
        sortOrder: 15,
      }),
    ];
    const snap = resolveChargeConfig(tagDefs, ["AIR_TAG_DG", "AIR_TAG_FRAGILE"], false, ["DG"]);
    expect(snap.lines.map((l) => l.definitionKey)).toEqual(["AIR_TAG_DG"]); // FRAGILE selected but no package carries it
  });

  it("omits a selected TAG_DRIVEN line when packageTags is defaulted (no 4th arg)", () => {
    const snap = resolveChargeConfig(defs, ["AIR_TAG_FRAGILE"], false);
    expect(snap.lines.map((l) => l.definitionKey)).not.toContain("AIR_TAG_FRAGILE");
  });

  it("includes a HEAVY_WEIGHT_CALC core line", () => {
    const heavyDefs = [
      def({
        key: "AIR_MAIN_HEAVY_WEIGHT",
        role: "CORE",
        inputType: "HEAVY_WEIGHT_CALC",
        zone: "MAIN_FREIGHT",
        sortOrder: 9,
      }),
    ];
    expect(resolveChargeConfig(heavyDefs, [], false, []).lines).toHaveLength(1);
  });
});
