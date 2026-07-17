import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Public } from "../auth/decorators/public.decorator";

@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  check(): { status: string } {
    return { status: "ok" };
  }

  @Get("db")
  async checkDb(): Promise<{ status: string; db: string }> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ok", db: "ok" };
  }
}
