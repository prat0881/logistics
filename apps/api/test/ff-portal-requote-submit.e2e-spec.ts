process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import type { QuoteDraft, ChargeZone } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";
import { ScheduledEventService } from "../src/modules/comms/scheduled-event.service";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// S5.5 Task 1 — the two foundations that let a REQUOTED quote complete its round-trip:
//  (a) the FF portal accepts a *submit* from a REQUOTED quote (-> QUOTED);
//  (b) the RFQ deadline-expiry sweep transitions an overdue REQUOTED quote (-> EXPIRED).
// The endpoint that PUTS a quote into REQUOTED in the first place (the negotiation "request
// re-quote" action) is a later task (S5.5 Task 2) — not built yet. So these tests seed the
// REQUOTED state directly, mirroring award-workflow-maker.e2e-spec.ts's FfSpec direct-seed
// convention (`status: ff.status` written straight onto the Quote row) for a status the HTTP
// surface can't produce yet, in order to test just this task's two exits in isolation.
const PREFIX = "FF-REQ";
const CODE = `YAL00-${PREFIX}`;

describe(`${PREFIX} (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let scheduled: ScheduledEventService;

  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  // Self-clean the comms rows too (ScheduledEvent/MessageLog reference entityId as a plain
  // string, not a Prisma relation, so they survive a Query/Rfq delete) — mirrors
  // ff-portal.e2e-spec.ts / rfq-expiry.e2e-spec.ts's own cleanup().
  const cleanup = async () => {
    const qs = await prisma.query.findMany({
      where: { queryCode: { startsWith: CODE } },
      select: { id: true },
    });
    const queryIds = qs.map((q) => q.id);
    const rfqs = queryIds.length
      ? await prisma.rfq.findMany({ where: { queryId: { in: queryIds } }, select: { id: true } })
      : [];
    const rfqIds = rfqs.map((r) => r.id);

    if (rfqIds.length) {
      await prisma.scheduledEvent.deleteMany({
        where: { entityType: "RFQ", entityId: { in: rfqIds } },
      });
    }
    if (queryIds.length) {
      await prisma.messageLog.deleteMany({
        where: { entityType: "QUERY", entityId: { in: queryIds } },
      });
    }
    for (const q of qs) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
      await prisma.rfq.deleteMany({ where: { queryId: q.id } });
      await prisma.query.delete({ where: { id: q.id } }); // cascades points/legs/legPackages/cargo/packages/items
    }
    await prisma.freightForwarder.deleteMany({
      where: { freightForwarderCode: { startsWith: `FF-${PREFIX}` } },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    scheduled = moduleRef.get(ScheduledEventService);
    await seedReferenceData(prisma);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  /**
   * Build a minimal distribute fixture and return the raw accessToken + the leg id (mirrors
   * ff-portal.e2e-spec.ts's own distributeFixture — Query -> origin/destination Points ->
   * Cargo->Package (LegPackage-assigned) -> Leg(AIR, READY_FOR_RFQ) -> FreightForwarder ->
   * PUT ff-selection -> POST distribute).
   */
  let fixtureSeq = 0;
  async function distributeFixture(): Promise<{ token: string; legId: string }> {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;

    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-FIXTURE-${seq}`, incoterms: "FOB" },
    });
    const origin = await prisma.point.create({
      data: { queryId: query.id, type: "PICKUP", country: "CN" },
    });
    const dest = await prisma.point.create({
      data: { queryId: query.id, type: "DELIVERY", country: "AE" },
    });
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: `L-${PREFIX}-${seq}`,
        mode: "AIR",
        status: "READY_FOR_RFQ",
        originPointId: origin.id,
        destinationPointId: dest.id,
        readyDate: new Date(),
        targetDelivery: new Date(Date.now() + 86400000),
      },
    });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ packageNo: `PO-${PREFIX}-${seq}`, dimL: 10, dimW: 20, dimH: 30, grossWt: 5 }],
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);

    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-${seq}`,
        companyName: `FF ${PREFIX} Co ${seq}`,
        companyAddress: "1 Test Street",
        country: "Test Country",
        city: "Test City",
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}-${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        handleDg: false,
        defaultCurrency: "USD",
      },
    });

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${leg.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${leg.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);

    const entry = res.body.rfqs[0];
    return { token: entry.accessToken as string, legId: leg.id };
  }

  /**
   * A complete, submittable v4 Air draft built off the GET response body — verbatim copy of
   * ff-portal.e2e-spec.ts's own fullValidDraft (see that file's header comment for the full
   * rationale of every field); duplicated locally per this codebase's established per-spec-file
   * draft-builder convention (see also comparison.e2e-spec.ts / award-workflow-maker.e2e-spec.ts's
   * roadDraft, ff-portal-grain.e2e-spec.ts's own fullValidDraft).
   */
  function fullValidDraft(
    legId: string,
    getBody: {
      legs: Array<{
        manifest: {
          cargo: Array<{ packageId: string; grossWt: string; volumeCbm: string | null }>;
        };
        seededCharges: Array<{
          zone: ChargeZone | null;
          definitionKey?: string;
          inputType?: string;
          presetKey: string | null;
          label: string;
        }>;
      }>;
    },
  ): QuoteDraft {
    const leg = getBody.legs[0];
    return {
      legId,
      mode: "AIR",
      currency: "USD",
      quoteValidityUntil: "2099-01-01T00:00:00.000Z",
      chargedWeightKg: 125,
      notes: null,
      cargo: leg.manifest.cargo.map((c) => ({
        packageId: c.packageId,
        grossWtKg: Number(c.grossWt),
        cbm: Number(c.volumeCbm ?? 0),
      })),
      charges: leg.seededCharges.map((c) =>
        c.inputType === "HEAVY_WEIGHT_CALC"
          ? {
              zone: c.zone,
              definitionKey: c.definitionKey,
              presetKey: c.presetKey,
              label: c.label,
              amount: null,
              rateVariant: null,
              pieceWeightKg: 4,
              airlineLimitKg: 2,
              ratePerExcessKg: 2.5,
            }
          : {
              zone: c.zone,
              definitionKey: c.definitionKey,
              presetKey: c.presetKey,
              label: c.label,
              amount: 10,
              rateVariant: null,
            },
      ),
      trucking: [],
      seaRates: [],
      warehouse: [],
      transit: {
        departureDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        arrivalDate: new Date(Date.now() + 32 * 86400000).toISOString(),
        guaranteedTransitDaysByVariant: { AIR: 2 },
      },
      dgSurchargeNote: null,
      termsConditions: null,
    };
  }

  // ── REQUOTED submit (Task 1a) ──

  it("submit: a REQUOTED quote (revised-price re-submission) -> 201 QUOTED; re-submitting the now-QUOTED quote -> 409", async () => {
    const { token, legId } = await distributeFixture();

    const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    const draft = fullValidDraft(legId, got.body);

    // PATCH (saveDraft) both stores the draft AND propagates currency/quoteValidityUntil onto the
    // Rfq row — submit() re-derives those two fields authoritatively from the Rfq row, not from
    // draftJson (ff-portal.service.ts), so skipping this step would 422 on Q_CURRENCY/Q_VALIDITY
    // for reasons unrelated to the REQUOTED guard under test. saveDraft has no status guard, so
    // this works identically whether the quote is RFQ_SENT (as it still is here) or REQUOTED.
    await request(app.getHttpServer())
      .patch(`/api/ff/rfq/${token}/quotes/${legId}`)
      .send(draft)
      .expect(200);

    // Directly move the quote to REQUOTED with its draft retained — simulates the OUTPUT state of
    // the (not-yet-built) "request re-quote" endpoint; see the file header for why this is seeded
    // directly rather than driven through HTTP.
    const quoteBefore = await prisma.quote.findFirstOrThrow({ where: { legId } });
    await prisma.quote.update({
      where: { id: quoteBefore.id },
      data: { status: "REQUOTED", submittedAt: new Date() },
    });

    // GET already worked pre-fix (resolveScope has no status guard) — confirm it still shows the
    // retained REQUOTED draft (the FF sees their earlier bid to revise, not a blank form).
    const gotAgain = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    expect(gotAgain.body.legs[0].status).toBe("REQUOTED");
    expect(gotAgain.body.legs[0].draft.chargedWeightKg).toBe(125);

    // THE FIX under test: submit from REQUOTED must now be accepted (pre-fix: 409 "already
    // submitted or is not open"). S5.9 Task 7 (D10): submit now also carries the stale-page
    // guard's `version`, echoed verbatim from the REQUOTED-reflecting GET above.
    const res = await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: gotAgain.body.legs[0].version })
      .expect(201);
    expect(res.body.status).toBe("QUOTED");
    expect(res.body.quoteId).toBe(quoteBefore.id);

    const quoteAfter = await prisma.quote.findUniqueOrThrow({ where: { id: quoteBefore.id } });
    expect(quoteAfter.status).toBe("QUOTED");
    expect(quoteAfter.submittedAt).not.toBeNull();
    const chargeLineCount = await prisma.chargeLine.count({ where: { quoteId: quoteBefore.id } });
    expect(chargeLineCount).toBeGreaterThan(0); // materialize actually ran

    // Guard still closed for a non-open status — the fix didn't over-open past RFQ_SENT/REQUOTED.
    // A fresh GET (reflecting the now-QUOTED status) so this exercises the STATUS guard, not the
    // version guard (a stale version here would also 409, but for the wrong reason).
    const gotFinal = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
    await request(app.getHttpServer())
      .post(`/api/ff/rfq/${token}/quotes/${legId}/submit`)
      .send({ version: gotFinal.body.legs[0].version })
      .expect(409);
  });

  // ── expiry sweep covers REQUOTED (Task 1b) ──

  it("expiry sweep: a REQUOTED quote -> EXPIRED, alongside an RFQ_SENT quote on the SAME rfq (no regression)", async () => {
    const admin = cookie(Role.ADMINISTRATOR);
    const seq = ++fixtureSeq;

    const query = await prisma.query.create({
      data: { queryCode: `${CODE}-EXP-${seq}`, incoterms: "FOB" },
    });
    const ff = await prisma.freightForwarder.create({
      data: {
        freightForwarderCode: `FF-${PREFIX}-EXP-${seq}`,
        companyName: `FF Exp Co ${seq}`,
        companyAddress: "1 Test Street",
        country: "Test Country",
        city: "Test City",
        pic: "P",
        contactNumber: "+1000000000",
        email: `ff-${PREFIX.toLowerCase()}-exp-${seq}@e2e.test`,
        availableCountries: ["CN", "AE"],
        modes: ["AIR"],
        handleDg: false,
        defaultCurrency: "USD",
      },
    });

    const mkLeg = async (legCode: string) => {
      const origin = await prisma.point.create({
        data: { queryId: query.id, type: "PICKUP", country: "CN" },
      });
      const dest = await prisma.point.create({
        data: { queryId: query.id, type: "DELIVERY", country: "AE" },
      });
      const { packageIds } = await createCargoWithPackages(prisma, {
        queryId: query.id,
        packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: 1 }],
      });
      const leg = await prisma.leg.create({
        data: {
          queryId: query.id,
          legCode,
          mode: "AIR",
          status: "READY_FOR_RFQ",
          originPointId: origin.id,
          destinationPointId: dest.id,
          readyDate: new Date(),
          targetDelivery: new Date(Date.now() + 86400000),
        },
      });
      await assignPackagesToLeg(prisma, leg.id, packageIds);
      return leg;
    };

    // Two legs distributed to the SAME FF -> ONE shared Rfq (Rfq is @@unique([queryId,
    // freightForwarderId]); rfq.service.ts's performDistribution looks up and reuses the existing
    // row on the second distribute call rather than minting a new one) carrying TWO Quotes. This
    // means the fix's single `where: { rfqId, status: { in: [...] } }` query has to sweep BOTH
    // statuses in the SAME onExpiry() pass to pass this test — a stronger proof than two
    // independently-triggered sweeps would be.
    const legA = await mkLeg(`L-${PREFIX}-EXPA-${seq}`);
    const legB = await mkLeg(`L-${PREFIX}-EXPB-${seq}`);

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${legA.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distA = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legA.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    const rfqId = distA.body.rfqs[0].rfqId as string;

    await request(app.getHttpServer())
      .put(`/api/queries/${query.id}/legs/${legB.id}/ff-selection`)
      .set("Cookie", admin)
      .send({ ffIds: [ff.id] })
      .expect(200);
    const distB = await request(app.getHttpServer())
      .post(`/api/queries/${query.id}/legs/${legB.id}/distribute`)
      .set("Cookie", admin)
      .send({})
      .expect(201);
    expect(distB.body.rfqs[0].rfqId).toBe(rfqId); // sanity: really the SAME shared Rfq

    const quoteA = await prisma.quote.findFirstOrThrow({ where: { legId: legA.id } });
    const quoteB = await prisma.quote.findFirstOrThrow({ where: { legId: legB.id } });
    expect(quoteA.status).toBe("RFQ_SENT");
    expect(quoteB.status).toBe("RFQ_SENT");

    // Flip quoteB to REQUOTED carrying BOTH JSON columns (same direct-seed convention as the
    // submit test above), with DIFFERENT values so the two assertions below cannot pass for each
    // other's reason. S5.9.6 (A6) split them: `submittedJson` is the price they offered, and a
    // REQUOTED quote's `draftJson` is only their last saved state — see rfq-schedule.listener.ts
    // for why the sweep can never prove those are equal. The assertions check by identity, so
    // arbitrary placeholder objects are all this test needs.
    await prisma.quote.update({
      where: { id: quoteB.id },
      data: {
        status: "REQUOTED",
        draftJson: { note: "revised bid in progress" },
        submittedJson: { note: "the price they actually submitted" },
        submittedAt: new Date(),
      },
    });

    // Force the ONE shared DEADLINE-tier rfq.expiry timer due now (ScheduledEventService.schedule
    // no-ops its upsert on an existing key, so drive dueAt directly — mirrors
    // rfq-expiry.e2e-spec.ts).
    await prisma.scheduledEvent.update({
      where: {
        entityType_entityId_eventKey_tier: {
          entityType: "RFQ",
          entityId: rfqId,
          eventKey: "rfq.expiry",
          tier: "DEADLINE",
        },
      },
      data: { dueAt: new Date() },
    });

    await scheduled.runDue();

    const quoteAAfter = await prisma.quote.findUniqueOrThrow({ where: { id: quoteA.id } });
    const quoteBAfter = await prisma.quote.findUniqueOrThrow({ where: { id: quoteB.id } });

    // Regression: the pre-existing RFQ_SENT sweep still works.
    expect(quoteAAfter.status).toBe("EXPIRED");
    expect(quoteAAfter.draftJson).toBeNull();
    // DELETED (S5.9.6 final review, MINOR 4): an `expect(quoteAAfter.submittedJson).toBeNull()`
    // used to sit here. It could not fail. quoteA is RFQ_SENT, a status on which `submittedJson`
    // is unreachable by construction — `submit` is the only writer and it moves the row to QUOTED,
    // and `RfqService.distribute` clears the column on the way back in (rfq.service.ts) — so the
    // fixture starts null, and `onExpiry`'s single write is `data: { draftJson: Prisma.DbNull }`
    // (rfq-schedule.listener.ts), which names no other column. Null before, null after, for no
    // reason the sweep controls.
    //
    // Where the invariant IS exercised: quoteB below, which carries a real `submittedJson` through
    // the same `onExpiry` pass and asserts it by identity afterwards — the REQUOTED arm is the only
    // arm on which the column can exist, so it is the only arm a sweep could destroy it on. The
    // write side (submit sets it, a later saveDraft leaves it alone) is ff-portal.e2e-spec.ts's
    // "submit records submittedJson" test.

    // THE FIX under test: REQUOTED is now swept too, in the same pass.
    expect(quoteBAfter.status).toBe("EXPIRED");
    // CHANGED (S5.9.5 Task 2, D4/register A4) — this used to assert `toBeNull()`. Destroying the
    // forwarder's already-submitted earlier price was the bug: it made asking for a better price
    // strictly worse than doing nothing. The sweep now discards the draft ONLY for RFQ_SENT
    // (quoteA above is the still-green control for that), and this file's shared-Rfq fixture is
    // what proves both branches are taken in ONE onExpiry pass.
    //
    // RE-AIMED (S5.9.6, register A6). The guarantee this line was written for — "the forwarder's
    // submitted price survives the sweep" — is now carried by `submittedJson`, which the sweep
    // never writes for EITHER status; that is the first assertion below and it is the one that
    // preserves the original purpose. The `draftJson` assertion is NARROWED and kept: what it pins
    // is portal PRE-FILL (resolveScope serves this column, so a re-negotiated forwarder opens onto
    // their previous numbers rather than a blank matrix), not provenance.
    expect(quoteBAfter.submittedJson).toEqual({ note: "the price they actually submitted" });
    expect(quoteBAfter.draftJson).toEqual({ note: "revised bid in progress" });
  });
});
