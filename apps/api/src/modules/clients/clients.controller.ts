import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  clientCreateSchema,
  clientUpdateSchema,
  contactCreateSchema,
  contactUpdateSchema,
} from "@svyft/shared";
import type {
  ClientCreateInput,
  ClientUpdateInput,
  ContactCreateInput,
  ContactUpdateInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { Role } from "@svyft/shared";
import { ClientsService } from "./clients.service";

@Controller("clients")
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list(
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("page") page = "1",
    @Query("pageSize") pageSize = "20",
  ) {
    return this.clients.list({
      q,
      status,
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(Math.max(1, Number(pageSize) || 20), 100),
    });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.clients.get(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(@Body(new ZodValidationPipe(clientCreateSchema)) body: ClientCreateInput) {
    return this.clients.create(body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(clientUpdateSchema)) body: ClientUpdateInput,
  ) {
    return this.clients.update(id, body);
  }

  @Get(":id/contacts")
  listContacts(@Param("id") id: string) {
    return this.clients.listContacts(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post(":id/contacts")
  addContact(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(contactCreateSchema)) body: ContactCreateInput,
  ) {
    return this.clients.addContact(id, body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id/contacts/:contactId")
  updateContact(
    @Param("id") id: string,
    @Param("contactId") contactId: string,
    @Body(new ZodValidationPipe(contactUpdateSchema)) body: ContactUpdateInput,
  ) {
    return this.clients.updateContact(id, contactId, body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Delete(":id/contacts/:contactId")
  @HttpCode(204)
  async removeContact(@Param("id") id: string, @Param("contactId") contactId: string) {
    await this.clients.removeContact(id, contactId);
  }
}
