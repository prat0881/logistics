import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class CodeSequenceService {
  constructor(private readonly prisma: PrismaService) {}

  async next(key: string, prefix: string): Promise<string> {
    const row = await this.prisma.codeSequence.update({
      where: { key },
      data: { lastNumber: { increment: 1 } },
    });
    return `${prefix}-${String(row.lastNumber).padStart(4, "0")}`;
  }
}
