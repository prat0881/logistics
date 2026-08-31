import { ConflictException } from "@nestjs/common";
import { contactUpsertSchema, PRIMARY_DUPLICATE_MESSAGE, type ContactUpsert } from "@svyft/shared";
import { reconcileContacts, type ContactDelegate } from "../src/common/reconcile-contacts";

/**
 * Unit-level cover for the query-before-write conflict guard. The e2e path can't reach it:
 * every parent schema already carries a one-primary refine, so a two-primary payload is a 400
 * long before the service sees it (see clients-composite.e2e-spec.ts). This guard is the
 * backstop for a caller that bypasses the schema, so it needs its own test — otherwise it is
 * covered by nothing at all.
 *
 * `ContactDelegate` is declared structurally precisely so a hand-built fake satisfies it with
 * no Prisma, no database and no Nest module.
 */

interface Call {
  method: "findMany" | "deleteMany" | "update" | "create";
  args: unknown;
}

function fakeDelegate(existing: { id: string }[] = []): ContactDelegate & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async findMany(args) {
      calls.push({ method: "findMany", args });
      return existing;
    },
    async deleteMany(args) {
      calls.push({ method: "deleteMany", args });
      return undefined;
    },
    async update(args) {
      calls.push({ method: "update", args });
      return undefined;
    },
    async create(args) {
      calls.push({ method: "create", args });
      return undefined;
    },
  };
}

/** Parse rather than hand-cast, so these fixtures are real z.output values with every
 *  `.default()` applied — the same shape the controller hands the service. */
function contact(overrides: Record<string, unknown>): ContactUpsert {
  return contactUpsertSchema.parse({
    name: "C",
    email: "c@x.com",
    contactNo: "+971501234567",
    ...overrides,
  });
}

const writeMethods = ["deleteMany", "update", "create"];

// contactUpsertSchema.id is z.string().uuid(), so these must be real UUIDs rather than
// readable slugs. Named constants keep the assertions below legible.
const PROMOTED = "11111111-1111-4111-8111-111111111111";
const INCUMBENT = "22222222-2222-4222-8222-222222222222";
const GONER = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";

describe("reconcileContacts", () => {
  it("rejects two primaries with a ConflictException naming the rule, before any write", async () => {
    const delegate = fakeDelegate([{ id: "existing-1" }]);

    const error = await reconcileContacts({
      delegate,
      ownerKey: "clientId",
      ownerId: OWNER,
      contacts: [
        contact({ name: "P1", email: "p1@x.com", pocLevel: "PRIMARY" }),
        contact({ name: "P2", email: "p2@x.com", pocLevel: "PRIMARY" }),
      ],
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe(PRIMARY_DUPLICATE_MESSAGE);
    // The point of the guard: it is a *query-before-write* check, so nothing was written.
    expect(delegate.calls.filter((c) => writeMethods.includes(c.method))).toEqual([]);
  });

  it("writes deletes, then demotions, then promotions — whatever order the payload lists them", async () => {
    // The positive control for the assertion above: without it, "no writes happened" could pass
    // against a fake that never records anything. It also pins the ordering the partial unique
    // index depends on, on the payload shape that needs it — a swap of which row is primary.
    const delegate = fakeDelegate([{ id: PROMOTED }, { id: INCUMBENT }, { id: GONER }]);

    await reconcileContacts({
      delegate,
      ownerKey: "clientId",
      ownerId: OWNER,
      contacts: [
        // The promotion is listed FIRST, so the ordering below can only come from the
        // implementation and not from the caller's array order.
        contact({ id: PROMOTED, name: "Promoted", pocLevel: "PRIMARY" }),
        contact({ id: INCUMBENT, name: "Demoted", pocLevel: "SECONDARY" }),
        contact({ name: "Brand new", email: "bn@x.com", pocLevel: "NONE" }),
      ],
    });

    expect(delegate.calls.map((c) => c.method)).toEqual([
      "findMany",
      "deleteMany", // 1. GONER, dropped from the payload
      "update", // 2. demotion of INCUMBENT, freeing the index
      "update", // 3. only then the promotion of PROMOTED
      "create", // 4. the new row
    ]);

    const [, del, demote, promote, created] = delegate.calls;
    expect(del.args).toEqual({ where: { id: { in: [GONER] } } });
    expect(demote.args).toMatchObject({
      where: { id: INCUMBENT },
      data: { pocLevel: "SECONDARY" },
    });
    expect(promote.args).toMatchObject({
      where: { id: PROMOTED },
      data: { pocLevel: "PRIMARY" },
    });
    expect(created.args).toMatchObject({
      data: { clientId: OWNER, name: "Brand new", pocLevel: "NONE" },
    });
    // `id` addresses the row; it is never written as a column.
    expect((created.args as { data: Record<string, unknown> }).data).not.toHaveProperty("id");
  });

  it("creates the non-primary rows before the primary one", async () => {
    // Not an index hazard — among creates there isn't one: the two-primary guard caps the
    // payload at a single PRIMARY, and deletes and promotions have both already run, so a lone
    // primary create cannot collide with anything. This pins the ordering as the defensive
    // consistency it is: a fresh owner whose payload happens to list its primary first still
    // writes that primary last, so "a primary is always written last" holds on every path.
    const delegate = fakeDelegate([]);

    await reconcileContacts({
      delegate,
      ownerKey: "freightForwarderId",
      ownerId: OWNER,
      contacts: [
        contact({ name: "The primary", email: "p@x.com", pocLevel: "PRIMARY" }),
        contact({ name: "The other", email: "o@x.com", pocLevel: "SECONDARY" }),
      ],
    });

    expect(delegate.calls.map((c) => c.method)).toEqual(["findMany", "create", "create"]);
    const [, first, second] = delegate.calls;
    // ownerKey is threaded through untouched, which is what lets Tasks 5 and 6 reuse this
    // module for a different owner FK without changing it.
    expect(first.args).toMatchObject({
      data: { freightForwarderId: OWNER, name: "The other", pocLevel: "SECONDARY" },
    });
    expect(second.args).toMatchObject({
      data: { freightForwarderId: OWNER, name: "The primary", pocLevel: "PRIMARY" },
    });
  });
});
