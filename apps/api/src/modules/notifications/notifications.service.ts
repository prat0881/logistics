import { Injectable, NotFoundException } from "@nestjs/common";
import type { NotificationDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createMany(
    userIds: string[],
    data: { type: string; queryId?: string | null; entityType?: string | null; entityId?: string | null; message: string; tenantId?: string | null },
  ): Promise<void> {
    if (!userIds.length) return;
    await this.prisma.notification.createMany({
      data: userIds.map((recipientUserId) => ({
        recipientUserId,
        type: data.type,
        queryId: data.queryId ?? null,
        entityType: data.entityType ?? null,
        entityId: data.entityId ?? null,
        message: data.message,
        tenantId: data.tenantId ?? null,
      })),
    });
  }

  async listForUser(userId: string, limit = 50): Promise<NotificationDto[]> {
    const rows = await this.prisma.notification.findMany({
      where: { recipientUserId: userId }, orderBy: { createdAt: "desc" }, take: limit,
    });
    return rows.map((r) => ({
      id: r.id, type: r.type, queryId: r.queryId, message: r.message,
      readAt: r.readAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { recipientUserId: userId, readAt: null } });
  }

  async markRead(id: string, userId: string): Promise<void> {
    const r = await this.prisma.notification.updateMany({
      where: { id, recipientUserId: userId }, data: { readAt: new Date() },
    });
    if (r.count === 0) throw new NotFoundException("Notification not found");
  }
}
