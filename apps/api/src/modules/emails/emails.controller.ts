import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { EmailsService } from "./emails.service";

@Controller("queries/:id/emails")
export class EmailsController {
  constructor(private readonly emails: EmailsService) {}

  @Post("follow-up")
  @HttpCode(201)
  followUp(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.emails.compose("query.follow_up", id, user.userId);
  }

  @Post("acknowledgement")
  @HttpCode(201)
  acknowledgement(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.emails.compose("query.acknowledgement", id, user.userId);
  }

  @Get()
  list(@Param("id") id: string) {
    return this.emails.list(id);
  }
}
