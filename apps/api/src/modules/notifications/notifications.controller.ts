import { Controller, Get, HttpCode, Param, Patch } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  listForUser(@CurrentUser() user: RequestUser) {
    return this.notifications.listForUser(user.userId);
  }

  @Get("unread-count")
  async unreadCount(@CurrentUser() user: RequestUser) {
    return { count: await this.notifications.unreadCount(user.userId) };
  }

  @Patch(":id/read")
  @HttpCode(200)
  markRead(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.notifications.markRead(id, user.userId);
  }
}
