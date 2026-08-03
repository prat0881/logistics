import { Injectable } from "@nestjs/common";
import {
  RFQ_DEADLINE_HOURS_KEY,
  RFQ_REMINDER_OFFSETS_KEY,
  DEFAULT_RFQ_DEADLINE_HOURS,
  DEFAULT_RFQ_REMINDER_OFFSETS,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class CommsSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async rfqDeadlineHours(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: RFQ_DEADLINE_HOURS_KEY } });
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RFQ_DEADLINE_HOURS;
  }

  async rfqReminderOffsets(): Promise<number[]> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: RFQ_REMINDER_OFFSETS_KEY } });
    if (!row) return [...DEFAULT_RFQ_REMINDER_OFFSETS];
    const parsed = row.value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    return parsed.length ? parsed : [...DEFAULT_RFQ_REMINDER_OFFSETS];
  }
}
