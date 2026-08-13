import type { CargoDto } from "@svyft/shared";
import { REFERENCE_TAGS } from "@svyft/shared";
import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";

/** Aggregate the reference tags present across a query's cargo, then render the shared
 *  icon set. DG is just another `ReferenceTag` (Stage-3) — no separate isDangerous flag. */
export function CargoTagIcons({ cargo }: { cargo: CargoDto[] }) {
  const presentTags = REFERENCE_TAGS.filter((tag) => cargo.some((c) => c.tags.includes(tag)));
  return <ReferenceTagIcons tags={presentTags} />;
}
