import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  contactCreateSchema,
  contactUpdateSchema,
  warehouseCreateSchema,
  warehouseUpdateSchema,
  warehouseVehicleSchema,
} from "@svyft/shared";
import type {
  ContactCreateInput,
  ContactUpdateInput,
  WarehouseCreateInput,
  WarehouseUpdateInput,
  WarehouseVehicleInput,
} from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import type { RequestUser } from "../auth/types";
import { Role } from "@svyft/shared";
import { WarehousesService } from "./warehouses.service";

@Controller("warehouses")
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  list(
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("type") type?: string,
    @Query("unassigned") unassigned?: string,
    @Query("page") page = "1",
    @Query("pageSize") pageSize = "20",
  ) {
    return this.warehouses.list({
      q,
      status,
      type,
      unassigned: unassigned === "true",
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(Math.max(1, Number(pageSize) || 20), 100),
    });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.warehouses.get(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(
    @Body(new ZodValidationPipe(warehouseCreateSchema)) body: WarehouseCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.warehouses.create(body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(warehouseUpdateSchema)) body: WarehouseUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.warehouses.update(id, body, user);
  }

  @Get(":id/contacts")
  listContacts(@Param("id") id: string) {
    return this.warehouses.listContacts(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post(":id/contacts")
  addContact(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(contactCreateSchema)) body: ContactCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.warehouses.addContact(id, body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id/contacts/:contactId")
  updateContact(
    @Param("id") id: string,
    @Param("contactId") contactId: string,
    @Body(new ZodValidationPipe(contactUpdateSchema)) body: ContactUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.warehouses.updateContact(id, contactId, body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Delete(":id/contacts/:contactId")
  @HttpCode(204)
  async removeContact(@Param("id") id: string, @Param("contactId") contactId: string) {
    await this.warehouses.removeContact(id, contactId);
  }

  @Get(":id/vehicles")
  listVehicles(@Param("id") id: string) {
    return this.warehouses.listVehicles(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post(":id/vehicles")
  addVehicle(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(warehouseVehicleSchema)) body: WarehouseVehicleInput,
  ) {
    return this.warehouses.addVehicle(id, body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Delete(":id/vehicles/:vehicleId")
  @HttpCode(204)
  async removeVehicle(@Param("id") id: string, @Param("vehicleId") vehicleId: string) {
    await this.warehouses.removeVehicle(id, vehicleId);
  }
}
