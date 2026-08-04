import type { CargoDto } from "@svyft/shared";
import { REFERENCE_TAGS } from "@svyft/shared";
import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";

/** Aggregate the reference tags present across a query's cargo + whether any row
 *  is dangerous, then render the shared icon set. */
export function CargoTagIcons({ cargo }: { cargo: CargoDto[] }) {
  const presentTags = REFERENCE_TAGS.filter((tag) => cargo.some((c) => c.referenceTags.includes(tag)));
  const anyDg = cargo.some((c) => c.isDangerous);
  return <ReferenceTagIcons tags={presentTags} isDangerous={anyDg} />;
}
