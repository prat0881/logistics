import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Response } from "express";

@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(
    exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError,
    host: ArgumentsHost,
  ): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof Prisma.PrismaClientValidationError) {
      res.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, message: "Invalid request" });
      return;
    }
    switch (exception.code) {
      case "P2025":
        res.status(HttpStatus.NOT_FOUND).json({ statusCode: 404, message: "Not found" });
        return;
      case "P2023":
        res.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, message: "Invalid identifier" });
        return;
      case "P2002":
        res.status(HttpStatus.CONFLICT).json({ statusCode: 409, message: "Already exists" });
        return;
      default:
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: 500,
          message: "Internal server error",
        });
        return;
    }
  }
}
