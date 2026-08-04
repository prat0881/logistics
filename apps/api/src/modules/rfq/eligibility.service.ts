import { Injectable } from "@nestjs/common";
import type { FreightForwarder } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { FreightForwardersService } from "../freight-forwarders/freight-forwarders.service";
import { loadLegForRfq } from "./leg-context";

@Injectable()
export class EligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ffs: FreightForwardersService,
  ) {}

  async getEligibleFfs(queryId: string, legId: string, broaden: boolean): Promise<FreightForwarder[]> {
    const ctx = await loadLegForRfq(this.prisma, queryId, legId);
    return this.ffs.findEligible({
      countries: ctx.endpointCountries,
      countriesComplete: ctx.endpointCountriesComplete,
      mode: ctx.leg.mode,
      requireDg: ctx.hasDg,
      broaden,
    });
  }
}
