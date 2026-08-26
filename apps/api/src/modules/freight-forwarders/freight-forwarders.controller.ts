import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  Role,
  freightForwarderCreateSchema,
  freightForwarderUpdateSchema,
  contactCreateSchema,
  contactUpdateSchema,
} from "@svyft/shared";
import type {
  FreightForwarderCreateInput,
  FreightForwarderUpdateInput,
  ContactCreateInput,
  ContactUpdateInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import type { RequestUser } from "../auth/types";
import { FreightForwardersService } from "./freight-forwarders.service";

@Controller("freight-forwarders")
export class FreightForwardersController {
  constructor(private readonly ffs: FreightForwardersService) {}

  @Get()
  list(
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("page") page = "1",
    @Query("pageSize") pageSize = "20",
  ) {
    return this.ffs.list({
      q,
      status,
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(Math.max(1, Number(pageSize) || 20), 100),
    });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.ffs.get(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(
    @Body(new ZodValidationPipe(freightForwarderCreateSchema)) body: FreightForwarderCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.ffs.create(body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(freightForwarderUpdateSchema)) body: FreightForwarderUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.ffs.update(id, body, user);
  }

  @Get(":id/contacts")
  listContacts(@Param("id") id: string) {
    return this.ffs.listContacts(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post(":id/contacts")
  addContact(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(contactCreateSchema)) body: ContactCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.ffs.createContact(id, body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id/contacts/:contactId")
  updateContact(
    @Param("id") id: string,
    @Param("contactId") contactId: string,
    @Body(new ZodValidationPipe(contactUpdateSchema)) body: ContactUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.ffs.updateContact(id, contactId, body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Delete(":id/contacts/:contactId")
  @HttpCode(204)
  async removeContact(@Param("id") id: string, @Param("contactId") contactId: string) {
    await this.ffs.deleteContact(id, contactId);
  }
}
