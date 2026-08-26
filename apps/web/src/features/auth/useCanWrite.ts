import { Role } from "@svyft/shared";
import { useAuth } from "./AuthProvider";

/**
 * Administrator OR Manager — the one role predicate every master-data write is gated on.
 *
 * Every master-data write endpoint (`@Roles(Role.ADMINISTRATOR, Role.MANAGER)` on the clients,
 * vessels, freight-forwarders, warehouses and charge-line-definitions controllers) enforces
 * exactly this pair, and `GET /api/charge-line-definitions/admin` is the one read gated the same
 * way. Executive is deliberately excluded — it is NOT the same predicate as "signed in", which is
 * what `ProtectedRoute` covers.
 *
 * Extracted because the literal `user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER`
 * had been copied verbatim into seven components; adding the missing guards on the master form
 * routes would have made that nine. A copied predicate is a predicate that drifts, and the copy
 * that drifts silently is the one that lets an Executive reach a form whose Save can only 403.
 */
export function canWriteMasters(role: string | null | undefined): boolean {
  return role === Role.ADMINISTRATOR || role === Role.MANAGER;
}

/** `canWriteMasters` for the signed-in user. */
export function useCanWrite(): boolean {
  const { user } = useAuth();
  return canWriteMasters(user?.role);
}
