import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { Role, quotationPatchSchema, type QuotationPatch } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { QuotationService } from "./quotation.service";

// Manager+ to build/price a client quotation (design doc "Decisions" — RBAC row), matching the
// existing gate on generating the client quote (§16 O4). Class-level so both routes inherit it.
@Roles(Role.ADMINISTRATOR, Role.MANAGER)
@Controller("queries/:id/quotation")
export class QuotationController {
  constructor(private readonly quotation: QuotationService) {}

  @Get()
  get(@Param("id") id: string) {
    return this.quotation.getOrCreateDraft(id);
  }

  @Patch()
  patch(@Param("id") id: string, @Body(new ZodValidationPipe(quotationPatchSchema)) body: QuotationPatch) {
    return this.quotation.patch(id, body);
  }
}
