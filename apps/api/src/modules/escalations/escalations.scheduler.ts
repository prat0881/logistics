import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { EscalationsService } from "./escalations.service";

@Injectable()
export class EscalationsScheduler {
  constructor(private readonly escalations: EscalationsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async poll(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    await this.escalations.runDue();
  }
}
