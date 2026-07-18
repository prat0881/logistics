import { BadRequestException, Injectable } from "@nestjs/common";
import { IMPACT_RANK, type ImpactClass } from "@svyft/shared";

// A field name, or the structural actions '@create' / '@delete'.
export type ImpactKey = string;
export type EntityImpactMap = Record<ImpactKey, ImpactClass>;

// Per-entity impact declarations (§7.3). Each owning module declares its own map;
// merged so later stages add fields without clobbering earlier ones.
@Injectable()
export class ImpactRegistry {
  private readonly maps = new Map<string, EntityImpactMap>();

  declare(entity: string, map: EntityImpactMap): void {
    this.maps.set(entity, { ...(this.maps.get(entity) ?? {}), ...map });
  }

  classOf(entity: string, key: ImpactKey): ImpactClass | undefined {
    return this.maps.get(entity)?.[key];
  }

  // Highest-impact field among `fields` — the field that names the ChangeRequest
  // (Stage-3 is always Free path, but this is the class that would gate the Stage-4
  // fork). Any field with no declared impact class is a 400, never a classifier 500.
  // The accumulator carries its own class so classOf is looked up once per field,
  // never recomputed on later reduce steps.
  highestImpactField(entity: string, fields: string[]): string {
    const best = fields.reduce<{ field: string; class: ImpactClass } | undefined>((hi, f) => {
      const c = this.classOf(entity, f);
      if (!c) throw new BadRequestException(`Field '${f}' is not editable`);
      return !hi || IMPACT_RANK[c] > IMPACT_RANK[hi.class] ? { field: f, class: c } : hi;
    }, undefined);
    if (!best) throw new BadRequestException("No fields to classify");
    return best.field;
  }
}
