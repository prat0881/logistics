import type { Role } from "@svyft/shared";

export interface JwtPayload {
  sub: string;
  role: Role;
  tenantId: string | null;
}

export interface RequestUser {
  userId: string;
  role: Role;
  tenantId: string | null;
}
