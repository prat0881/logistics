import { Injectable } from "@nestjs/common";
import type { ImpactClass } from "@svyft/shared";

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
}
