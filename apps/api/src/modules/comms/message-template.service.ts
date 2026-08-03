import { Injectable } from "@nestjs/common";
import type { Channel } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class MessageTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(
    eventKey: string,
    channel: Channel,
  ): Promise<{ key: string; subject: string | null; body: string } | null> {
    const row = await this.prisma.messageTemplate.findFirst({
      where: { eventKey, channel, active: true },
      select: { key: true, subject: true, body: true },
    });
    return row;
  }
}
