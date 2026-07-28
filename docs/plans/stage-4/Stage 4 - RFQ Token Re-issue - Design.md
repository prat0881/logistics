# Stage 4 — RFQ Access-Token Re-issue — Design

> Follow-up to Sub-build 2b, flagged by the SB2b whole-branch (opus) review. Backend-only, `apps/api`. To land **before SB5** starts composing FF portal links.

## Problem

`RfqService.performDistribution` mints a 256-bit access token per RFQ on first distribute, persists **only** `sha256(token)` as `Rfq.accessTokenHash`, and returns the raw token once in the HTTP response (`DistributeRfqEntry.accessToken`) — it is never stored. The `Rfq` row commits inside a `$transaction`; the status changes fire **after** it (because `StatusService.fire` opens its own transaction). If a `status.fire` throws, or the process/connection dies before the response is delivered, the `Rfq` row is committed but the raw token is gone. A retry hits the `minted:false` amend branch (via `@@unique([queryId, freightForwarderId])`) and returns no token. The hash is one-way, so that RFQ's FF portal link can never be constructed — a permanently dead RFQ that still blocks re-minting.

## Decision

**Option (a): an authenticated re-issue endpoint** that rotates the token (mints fresh, overwrites the hash, returns the new raw token). Rejected option (b) "persist the token encrypted at rest" because it would store a reversible secret and introduce key management — weakening the hash-only posture that is otherwise correct. In the failure mode the old link was **never delivered**, so rotating (invalidating any prior link) costs nothing; it also doubles as a general "rotate a leaked link" capability.

**Keyed by `(queryId, freightForwarderId)`, not `rfqId`.** In the failure scenario the caller lost the very response that carried the `rfqId`, and there is no `GET /queries/:id/rfqs` endpoint yet — but the operator always knows *query + which forwarder*. The `@@unique([queryId, freightForwarderId])` makes that lookup exact, so the endpoint is self-sufficient. The `rfqId` is returned in the response.

**Audit the rotation** via a dedicated `RfqTokenReissue` table (re-issues only). Not `StatusTransition` — that table is the status-*machine* audit (`from`/`to` are machine states) and reusing it for a non-transition would be semantically muddy and pollute status queries. Re-issues **only** (not the initial mint) so the merged `performDistribution` is untouched: logging the mint there would require inserting an `actorId @db.Uuid` inside distribute, which would break the existing e2e suite (they authenticate with a synthetic non-UUID subject `u-EXECUTIVE`). The initial-issue time is already on `Rfq.createdAt`, so `createdAt` + the reissue rows form a complete trail.

## Contract

**Schema (additive migration `add_rfq_token_reissue`):**
```prisma
model RfqTokenReissue {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String?  @db.Uuid
  rfqId     String   @db.Uuid
  rfq       Rfq      @relation(fields: [rfqId], references: [id], onDelete: Cascade)
  actorId   String?  @db.Uuid
  createdAt DateTime @default(now())

  @@index([rfqId])
}
```
Back-relation `tokenReissues RfqTokenReissue[]` added to `Rfq`. `onDelete: Cascade` means deleting a query cascades `Rfq` → cascades these rows (test cleanup handled for free).

**Endpoint:** `POST /api/queries/:id/rfqs/reissue-token` — **Executive+** (no `@Roles`, authenticated only). Body `{ freightForwarderId: uuid }` validated by `reissueTokenSchema` (`@svyft/shared`).

**Service** `RfqService.reissueToken(queryId, freightForwarderId, user)`:
1. `$transaction`:
   - find `Rfq` by `queryId_freightForwarderId` → **404 NotFound** if none;
   - `token.mint()`; `tx.rfq.update` set `accessTokenHash` = new hash;
   - `tx.rfqTokenReissue.create({ rfqId, actorId: user.userId, tenantId: user.tenantId })`.
2. Return `{ rfqId, rfqNumber, freightForwarderId, accessToken }` (the new raw token, once).
Untouched: `submissionDeadline`, quote/leg/query status, quotes, manifest.

**Shared (`packages/shared/src/rfq.ts`):** `reissueTokenSchema = z.object({ freightForwarderId: z.string().uuid() })`; `type ReissueTokenInput`; `interface ReissueTokenResult { rfqId; rfqNumber; freightForwarderId; accessToken }`.

## Testing (e2e `apps/api/test/rfq-reissue-token.e2e-spec.ts`)

Self-contained fixtures; FK-safe prefix cleanup; `await app.close()` in `afterAll`. **Authenticate with an EXECUTIVE cookie whose `sub` is a real UUID** so `actorId` records and can be asserted. Flow: build a query/leg/points/cargo/FF → distribute (capture the original `accessToken` + the stored `accessTokenHash`) → `POST reissue-token { freightForwarderId }` → assert:
- 201, `accessToken` is new (≠ original, 64 hex), `sha256(new) === Rfq.accessTokenHash` refetched, and the stored hash **changed** from the original;
- `submissionDeadline`, status, and `rfqNumber` are **unchanged**;
- exactly **one** `RfqTokenReissue` row exists for that `rfqId` with `actorId` = the caller's UUID;
- a second reissue rotates again (new hash, a **second** audit row);
- unknown `(query, FF)` → **404**.

## Out of scope / notes

- No state guard (SB2b has no "revoked/closed" RFQ state); SB4/SB6 may add guards once quotes-submitted / change-order states exist.
- Not idempotent by design (each call rotates) — that is the point.
- Once SB5 sends real links, re-issuing invalidates a previously-sent link; surfacing a "this invalidates the current link" confirmation is an SB3/SB5 UI concern, not this endpoint's.

## Verification

`pnpm --filter @svyft/shared build` · `pnpm --filter @svyft/api typecheck` · `pnpm --filter @svyft/api lint` · `cd apps/api && pnpm test` (full suite passes AND process exits) · root `pnpm run lint` + `pnpm run typecheck` (CI parity). Migration additive on the `:5433` dev DB (never reset).
