import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
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
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import type { RequestUser } from "../auth/types";
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
  create(
    @Body(new ZodValidationPipe(clientCreateSchema)) body: ClientCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.create(body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(clientUpdateSchema)) body: ClientUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.update(id, body, user);
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
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.addContact(id, body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id/contacts/:contactId")
  updateContact(
    @Param("id") id: string,
    @Param("contactId") contactId: string,
    @Body(new ZodValidationPipe(contactUpdateSchema)) body: ContactUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.updateContact(id, contactId, body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Delete(":id/contacts/:contactId")
  @HttpCode(204)
  async removeContact(@Param("id") id: string, @Param("contactId") contactId: string) {
    await this.clients.removeContact(id, contactId);
  }

  @Get(":id/warehouses")
  listWarehouses(@Param("id") id: string) {
    return this.clients.listWarehouses(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Put(":id/warehouses")
  setWarehouses(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(z.object({ warehouseIds: z.array(z.string().uuid()) })))
    body: { warehouseIds: string[] },
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.setWarehouses(id, body.warehouseIds, user);
  }
}
