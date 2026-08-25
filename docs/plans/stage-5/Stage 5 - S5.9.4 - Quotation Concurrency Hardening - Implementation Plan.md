# Stage 5 · S5.9.4 — Quotation Concurrency Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close register items **C10** and **C11** — the last unguarded write on the quotation row, and the false refusal its sibling guard can produce.

**Architecture:** Both live in `QuotationService.patch` and its callers. C10 folds the status check into the UPDATE's own WHERE, matching what S5.9.3 already did on the issue side. C11 stops a no-op PATCH from moving `updatedAt`, which is what makes the issue-side guard cry wolf.

## Global Constraints

- **Do not weaken or remove the issue-side concurrency guard.** It is what closes the cross-client stale-letter hole: a manager in one tab could otherwise send a client a letter whose total disagrees with what is charged, with nobody making a mistake. C11 exists so that guard stops firing *spuriously*, not so it fires less.
- **The four client-document must-keeps still hold and must be re-verified:** the body is prefilled from the server render, the **grand total stays server-authoritative**, the issued record stores the letter actually sent, and an empty body is refused server-side.
- Every owned status change goes through `StatusService.fire`; query status is a projection, never fired; fires only after the enclosing transaction commits.
- **No schema change.** If one seems necessary, STOP and report.
- Vocabulary (D5): "Award" may name only the future disabled rail stage, never anything that has happened. Nothing forwarder-facing reveals a commercial outcome.
- No toast system — surface `ApiError` inline via `errorMessage(error, fallback)`.
- `packages/shared` is CommonJS — rebuild after editing.
- vitest/jest do NOT type-check — `pnpm run typecheck` is a separate gate.
- API e2e: `set -a; . apps/api/.env; set +a`, Postgres on **5433**, `--runInBand`. Known flakes (register C5): `award-generate`, `ff-portal-v3`, `charge-catalogue`, `emails`, `ff-portal-stale-submit` — confirm, re-run, report; never "fix".
- **Every absence assertion mutation-proven** (break → red → revert → green), evidence reported. This branch has shipped five tests that could not fail; the two recurring shapes are an absence assertion with no positive control, and two failure modes collapsing under a short-circuit.
- `pnpm run ci` green at branch tip (shared 397 · web 886 · api 475 / 94 suites) and must stay green.
- **Verify `git branch --show-current`** — expected `feat/stage-5-fx-master`.

## Decisions

| # | Decision | Why |
| :-- | :-- | :-- |
| **N1** | **C10 — the DRAFT check moves into the UPDATE's WHERE clause**, with a 409 when it matches nothing. | `patch` currently reads the row, checks `status !== "DRAFT"`, then updates on `id` alone. A PATCH racing a winning `issue()` can therefore write `marginPct` / `draftJson` / the totals onto a quotation that has already gone to the client. This is the same fix already applied on the issue side. |
| **N2** | **C11 — a PATCH that changes nothing must not move `updatedAt`.** Enforce it server-side, not at the trigger. | The row's timestamp is a server concern, and a client-side check cannot cover a *different* client — which is the whole population the issue-side guard protects against. A no-op must return the current state without writing. |
| **N3** | **The DRAFT refusal still applies to a no-op.** | Editing an issued quotation is refused whether or not the edit would change anything; silently accepting a no-op on an issued row would misreport it as editable. |

---

## Task 1: Guard the write, and stop no-ops moving the clock

**Files:** `apps/api/src/modules/quotation/quotation.service.ts`, `apps/api/test/quotation.e2e-spec.ts`, and — only if a trigger genuinely needs it — `apps/web/src/features/quotation/QuotationPage.tsx`.

**C10.** `patch` reads the quotation, checks `status !== "DRAFT"`, then calls `update({ where: { id: current.id } })`. The check and the write are not atomic. Fold the status into the write's own condition so the database refuses it, and 409 when nothing matched. Prisma's `update` takes only unique fields in `where`, so this needs `updateMany` plus a re-read, or an equivalent — the issue side already solved the same problem; **read how it did it and stay consistent** rather than inventing a second shape.

Keep the up-front check too. It is what produces the actionable message; the WHERE clause is what makes it correct. Say in your report which one produces the 409 in each case.

**C11.** Every PATCH currently moves `updatedAt`, because Prisma's `@updatedAt` stamps on every update regardless of whether a value changed — and no trigger guards on "did anything actually change": a keystroke debounces a PATCH, a blur commits one, and "Reset overrides" posts unconditionally. So another tab clicking Reset with nothing overridden makes the *issue-side* guard refuse a legitimate send with "this quotation was repriced", when it was not.

Make a PATCH that changes nothing a genuine no-op: no write, `updatedAt` unmoved, current state returned. Decide carefully what "changes nothing" means — margin, the overrides map, and anything else `patch` persists — and be precise about comparison: a numeric margin that arrives as a differently-formatted equal value is *not* a change, and an overrides map with the same entries in a different key order is *not* a change. Say how you compared.

**Do not weaken the issue-side guard to achieve this.** If a genuine reprice happens, `updatedAt` must still move and the issue must still be refused.

- [ ] **Step 1: Write the failing tests.** At minimum: a PATCH racing a winning issue cannot mutate the issued row (concurrent, real HTTP, not mocked); a no-op PATCH leaves `updatedAt` byte-identical and returns current state; a no-op PATCH on an ISSUED row is still refused; a *genuine* reprice still moves `updatedAt` and still causes the issue-side 409; and the existing issue-side concurrency test still passes unchanged.
- [ ] **Step 2: Run them; confirm each fails for the right reason** — not merely that it fails.
- [ ] **Step 3: Implement N1.**
- [ ] **Step 4: Implement N2.**
- [ ] **Step 5: Run the api and web suites, mutation-proving each new test** — including that removing the WHERE-clause guard reddens the race test, and removing the no-op short-circuit reddens the `updatedAt` test.
- [ ] **Step 6: Re-verify the four client-document must-keeps** still hold, and say so explicitly.
- [ ] **Step 7: `pnpm run typecheck`, run the full gate, then commit.**
- [ ] **Step 8: Update `docs/Stage 5 - Session Handoff.md`** — mark C10 and C11 closed, naming what closed each and the test that pins it, and note that the issue-side guard is unchanged and still load-bearing.

---

## Self-review notes

- **Coverage:** C10 → N1 · C11 → N2/N3.
- **The likeliest silent failure** is a no-op comparison that is too loose — treating a genuine reprice as a no-op would leave the row's clock unmoved and hand a stale letter straight through the issue-side guard, converting a cosmetic annoyance into the exact data defect that guard exists to stop. The test that a genuine reprice still moves `updatedAt` **and** still 409s the issue is the one that must not be vacuous.
- **The second likeliest** is fixing C11 at the trigger instead of the server, which would leave every other client — including a second tab — still moving the clock on no-ops.
