import type { ManifestSnapshot } from "@svyft/shared";

/**
 * True when `manifest` is in the current v2 per-package shape the portal UI expects (see
 * `ManifestSnapshotCargo` in packages/shared/src/rfq.ts). RFQs distributed before the
 * Cargo→Package re-model froze an older manifest shape into `Quote.manifestSnapshot`
 * (`draftJson` too) — the v2 components that read `manifest.cargo` (CargoManifestTable,
 * ChargedWeightGrid, draftFromDto, the DG-tag check in LegSection) all assume this shape and
 * throw on the old one.
 *
 * Callers gate on this before rendering per-leg quote UI and fall back to a friendly notice
 * instead (see LegSection.tsx / ManifestUnavailableCard in terminalStates.tsx). Deliberately does
 * NOT try to parse or repair old-shape data — it only decides whether it's safe to render.
 */
export function isV2Manifest(manifest: ManifestSnapshot | null | undefined): boolean {
  const cargo = manifest?.cargo;
  return (
    Array.isArray(cargo) &&
    cargo.every((c) => c != null && typeof c.packageId === "string" && Array.isArray(c.tags))
  );
}
