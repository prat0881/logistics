import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Maps a `Warehouse_single_owner` CHECK-constraint violation (SQLSTATE 23514, added by
 * migration `warehouse_single_owner_check`) to a clean 409.
 *
 * The application-level contested check in `FreightForwardersService.setWarehouses` /
 * `ClientsService.setWarehouses` closes the ordinary case, but under Postgres's default Read
 * Committed isolation two concurrent writers — one PUT assigning a free warehouse to a
 * forwarder, another PUT assigning the *same* free warehouse to a client — can each read the
 * other's owner column as still null, each pass their own contested check, and only collide at
 * commit. Postgres then raises 23514, which Prisma surfaces as a
 * `PrismaClientUnknownRequestError` rather than a `PrismaClientKnownRequestError` with a
 * mappable `code` (CHECK-constraint violations aren't one of Prisma's known error codes — they
 * fall back to embedding the raw Postgres error text in `.message`). `PrismaExceptionFilter`
 * only `@Catch`es `PrismaClientKnownRequestError`/`PrismaClientValidationError`, so without this
 * mapping the race would surface as an unhandled 500 instead of the same conflict shape the
 * ordinary contested check already returns.
 */
export function mapOwnershipRace(e: unknown): unknown {
  if (
    e instanceof Prisma.PrismaClientUnknownRequestError &&
    e.message.includes("Warehouse_single_owner")
  ) {
    return new ConflictException(
      "This warehouse was just assigned to another record — please refresh and try again",
    );
  }
  return e;
}
