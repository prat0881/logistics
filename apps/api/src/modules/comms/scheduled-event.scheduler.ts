import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ScheduledEventService } from "./scheduled-event.service";

@Injectable()
export class ScheduledEventScheduler {
  constructor(private readonly scheduled: ScheduledEventService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async poll(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    await this.scheduled.runDue();
  }
}
