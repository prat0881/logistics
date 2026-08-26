import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";
import { renderWithProviders } from "@/test/renderWithProviders";
import { ApiError, postJson } from "@/lib/api";
import { STALE_OFFER_LABEL } from "./comparisonRowModel";
import { SendForApprovalDialog } from "./SendForApprovalDialog";

// `postJson` is mocked directly rather than via the usual `mockFetch`/global-`fetch` stub: this
// dialog issues exactly ONE call shape (`postJson(url, body)`), and asserting on the body object
// straight off `postJson.mock.calls` is simpler and more direct than round-tripping it through
// `JSON.stringify`/`JSON.parse` on a captured `RequestInit.body`. `ApiError` is kept real (not
// mocked) — `errorMessage.ts` does `error instanceof ApiError`, and the mocked module below spreads
// `...actual` so the class reference this test imports IS the one the component checks against.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, postJson: vi.fn() };
});

const postJsonMock = vi.mocked(postJson);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────
// Three priced offers (one recommended, one plain, one stale/REQUOTED) plus one UNPRICED offer —
// the unpriced one must never appear as a radio option. Names are deliberately similar in shape
// ("Bridge Logistics" / "Falcon Freight") to mirror the product ask this dialog exists to satisfy:
// an executive picking between similarly-named forwarders needs each option's own Total (USD)
// alongside it, not a memory of the grid.
const recommendedQuoteId = "quote-bridge";
const oceanicQuoteId = "quote-oceanic";
const staleQuoteId = "quote-falcon";

// Review round IMPORTANT 2 — nothing in this file previously asserted the request URL at all
// (`postJson.mock.calls[0][1]` only inspects the BODY), so a `useSendForApproval` repointed at the
// retired `PUT .../shortlist` route (a guaranteed 404 in production) would leave the whole suite
// green. Every test below that asserts a request body now also asserts this.
const SEND_URL = "/api/queries/q1/legs/leg-1/send-for-approval";

const BRIDGE_DEDICATED: OfferDto = {
  quoteId: recommendedQuoteId,
  freightForwarderId: "ff-bridge",
  freightForwarderName: "Bridge Logistics",
  variant: "DEDICATED",
  variantLabel: "Dedicated",
  priced: true,
  nativeTotal: 45540,
  currency: "AED",
  unitsPerUsd: 3.6725,
  usdTotal: 12400.0,
  transitDays: 3,
  chargeableWeightKg: 500,
  validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "QUOTED",
  charges: [],
};

const OCEANIC_GROUPAGE: OfferDto = {
  quoteId: oceanicQuoteId,
  freightForwarderId: "ff-oceanic",
  freightForwarderName: "Oceanic",
  variant: "GROUPAGE",
  variantLabel: "Groupage",
  priced: true,
  nativeTotal: 36000,
  currency: "AED",
  unitsPerUsd: 3.6725,
  usdTotal: 9802.58,
  transitDays: 6,
  chargeableWeightKg: 500,
  validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "QUOTED",
  charges: [],
};

const FALCON_STALE: OfferDto = {
  quoteId: staleQuoteId,
  freightForwarderId: "ff-falcon",
  freightForwarderName: "Falcon Freight",
  variant: "DEDICATED",
  variantLabel: "Dedicated",
  priced: true,
  nativeTotal: 41000,
  currency: "AED",
  unitsPerUsd: 3.6725,
  usdTotal: 11163.37,
  transitDays: 4,
  chargeableWeightKg: 500,
  validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "REQUOTED",
  charges: [],
};

const GLOBEX_UNPRICED: OfferDto = {
  quoteId: "quote-globex",
  freightForwarderId: "ff-globex",
  freightForwarderName: "Globex",
  variant: "GROUPAGE",
  variantLabel: "Groupage",
  priced: false,
  nativeTotal: 0,
  currency: "AED",
  unitsPerUsd: 3.6725,
  usdTotal: 0,
  transitDays: null,
  chargeableWeightKg: 500,
  validUntil: null,
  quoteStatus: "QUOTED",
  charges: [],
};

// The leg's decision already carries a PERSISTED shortlist on Bridge — the "elsewhere" value the
// S5.6 Critical would have silently submitted instead of whatever the maker has actually checked
// in the dialog right now (e.g. left over from an earlier send that a checker later rejected back
// to DRAFT, per `MakerPanel`'s "a rejected leg comes back as DRAFT" contract).
const LEG: LegComparisonDto = {
  legId: "leg-1",
  legCode: "LEG-1",
  mode: "ROAD",
  origin: "Chennai",
  destination: "Mumbai",
  offers: [BRIDGE_DEDICATED, OCEANIC_GROUPAGE, FALCON_STALE, GLOBEX_UNPRICED],
  pendingForwarders: [],
  awaitingReQuote: false,
  recommendation: { quoteId: recommendedQuoteId, variant: "DEDICATED", reason: "cheapest landed cost" },
  decision: {
    legId: "leg-1",
    status: "DRAFT",
    shortlistedQuoteId: recommendedQuoteId,
    shortlistedVariant: "DEDICATED",
    recommendedQuoteId,
    recommendedVariant: "DEDICATED",
    overrideReason: null,
    rejectionReason: null,
    sentByUserId: null,
    sentForApprovalAt: null,
    decidedByUserId: null,
    decidedAt: null,
  },
  timeline: [],
};

function renderDialog({
  leg = LEG,
  impl,
}: {
  leg?: LegComparisonDto;
  impl?: () => unknown;
} = {}) {
  postJsonMock.mockImplementation(() => {
    if (impl) {
      const result = impl();
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    }
    return Promise.resolve({ legId: leg.legId, status: "PENDING_APPROVAL" });
  });

  const onOpenChange = vi.fn();
  renderWithProviders(
    <SendForApprovalDialog open onOpenChange={onOpenChange} queryId="q1" leg={leg} />,
    { user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" } },
  );
  return { onOpenChange };
}

describe("SendForApprovalDialog", () => {
  it("lists every priced offer with its forwarder, variant and USD total", async () => {
    renderDialog();
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(3);
    expect(screen.getByLabelText(/Bridge Logistics — Dedicated/)).toBeInTheDocument();
    expect(screen.getByText("$12,400.00")).toBeInTheDocument();
  });

  it("omits unpriced offers rather than showing a fake $0", () => {
    renderDialog();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Globex/)).not.toBeInTheDocument();
  });

  it("allows exactly one selection", async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/));
    await userEvent.click(screen.getByLabelText(/Oceanic — Groupage/));
    expect(screen.getByLabelText(/Bridge Logistics — Dedicated/)).not.toBeChecked();
    expect(screen.getByLabelText(/Oceanic — Groupage/)).toBeChecked();
  });

  it("disables Send until an offer is selected", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /send for approval/i })).toBeDisabled();
  });

  // ── Review round — the reason block used to unmount whenever `overrideRequired` went false,
  // which destroyed a manually-set "reason required" error along with it for free. The PO ruling
  // keeps it permanently mounted, so nothing cleared that error on switching selections any more:
  // trip it on a non-recommended pick, then switch to the recommendation, and the label/help text
  // correctly flipped to "optional" while the red alert underneath still insisted a reason was
  // required. ─────────────────────────────────────────────────────────────────────────────────
  it("clears a stale required-reason error when the selection changes to the recommended offer", async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/Oceanic — Groupage/)); // not recommended
    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reason is required/i);

    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/)); // recommended

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Positive control — the field itself is still there, correctly relabelled, not just
    // coincidentally absent because something else unmounted.
    expect(screen.getByLabelText(/reason \(optional\)/i)).toBeInTheDocument();
  });

  // ── Ride-along question (review round) — the SAME field never unmounting between selections
  // means a reason TYPED for one offer could just as easily survive a switch to a different offer
  // and get silently attached to that offer's submit instead — the same class of staleness as the
  // error above, just on the value rather than the error. `resetField` (the fix for both) clears
  // the typed text too; this pins that half of the fix so it can't regress independently of the
  // error-clearing half. ──────────────────────────────────────────────────────────────────────
  it("does not carry a reason typed for one offer over to a newly selected offer", async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/Oceanic — Groupage/)); // not recommended
    await userEvent.type(
      screen.getByLabelText(/override reason/i),
      "Oceanic specifically is cheaper here.",
    );

    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/)); // recommended
    expect(screen.getByLabelText(/reason \(optional\)/i)).toHaveValue("");

    // Belt and suspenders — send the recommended offer now and confirm the stale Oceanic-specific
    // text never reaches the wire at all (not even as an unwanted voluntary reason).
    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(postJsonMock.mock.calls[0][1]).toEqual({
      quoteId: recommendedQuoteId,
      variant: "DEDICATED",
    });
  });

  it("requires a reason only when the pick is not the recommendation", async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/Oceanic — Groupage/)); // not recommended
    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reason is required/i);
    expect(postJson).not.toHaveBeenCalled();
  });

  // ── PO ruling (review round) — the reason field is ALWAYS visible, for every selection, not
  // conditionally mounted on `overrideRequired`. It stays optional on the recommended path; only
  // its requiredness (and the label/help text explaining which state it's in) changes with the
  // pick. This replaces the pre-ruling "reason box never touched" test, which asserted the box's
  // ABSENCE — the opposite of current, correct behaviour.
  it("shows the reason field labelled optional for the recommended offer, and leaves it out of the wire when left blank", async () => {
    renderDialog();
    const reasonBox = screen.getByLabelText(/reason \(optional\)/i);
    expect(reasonBox).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/)); // recommended
    // Still labelled optional after picking the recommendation — never touched.
    expect(screen.getByLabelText(/reason \(optional\)/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(postJsonMock.mock.calls[0][0]).toBe(SEND_URL);
    expect(postJsonMock.mock.calls[0][1]).toEqual({
      quoteId: recommendedQuoteId,
      variant: "DEDICATED",
    });
  });

  // ── PO ruling — "else user can voluntarily fill." A reason typed on the RECOMMENDED path must
  // still reach the wire; the field is optional, not inert. The pre-ruling body-build
  // (`...(overrideRequired ? { overrideReason: reason } : {})`) silently dropped this — this test
  // is mutation-proved against exactly that regression.
  it("sends a voluntary reason typed on the recommended path", async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/)); // recommended
    await userEvent.type(screen.getByLabelText(/reason \(optional\)/i), "Prefer this forwarder's SLA.");
    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(postJsonMock.mock.calls[0][0]).toBe(SEND_URL);
    expect(postJsonMock.mock.calls[0][1]).toEqual({
      quoteId: recommendedQuoteId,
      variant: "DEDICATED",
      overrideReason: "Prefer this forwarder's SLA.",
    });
  });

  it("closes the dialog once the send succeeds", async () => {
    const { onOpenChange } = renderDialog();
    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/));
    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // S5.9 final whole-branch review, IMPORTANT 1 — this test used to assert the OPPOSITE ("keeps a
  // stale (REQUOTED) offer selectable"), pinning the wrong side of the contract: it was ported
  // from `ShortlistDialog`'s pre-Task-3 behaviour, but since Task 3 the server's in-transaction A1
  // refresh (`award.service.ts`) refuses any named quote outside `SENDABLE_STATUSES` — `QUOTED`
  // or, since S5.9.5 D4, `EXPIRED` (CORRECTED review round 1: this used to say "isn't `QUOTED`
  // right now", which S5.9.5 Task 2 falsified). `REQUOTED` is in neither, so what this test pins
  // is unchanged — the refusal `award-workflow-maker.e2e-spec.ts`'s "CRITICAL 2" test asserts.
  // Selecting one could therefore only ever end in a 409 ("Only a live or expired offer can be
  // sent for approval…"), which cannot help: it is still REQUOTED after a refresh. Listed +
  // disabled + explained, per `NegotiateDialog`'s ineligible-forwarder pattern.
  it("lists a stale (REQUOTED) offer but disables it, with its warning and a reason", async () => {
    renderDialog();
    const staleRadio = screen.getByLabelText(/Falcon Freight — Dedicated/);
    expect(staleRadio).toBeInTheDocument(); // never hidden
    expect(staleRadio).toBeDisabled();
    expect(screen.getByText(STALE_OFFER_LABEL)).toBeInTheDocument();
    expect(screen.getByText(/isn’t live while a re-quote is outstanding/i)).toBeInTheDocument();

    await userEvent.click(staleRadio);
    expect(staleRadio).not.toBeChecked();
  });

  // The converse, so "disabled" can't quietly widen into "everything is disabled": a live QUOTED
  // offer stays pickable and carries neither the badge nor the reason.
  it("leaves a live (QUOTED) offer selectable, with no stale badge or reason on it", async () => {
    renderDialog();
    const liveRadio = screen.getByLabelText(/Bridge Logistics — Dedicated/);
    expect(liveRadio).not.toBeDisabled();
    await userEvent.click(liveRadio);
    expect(liveRadio).toBeChecked();
    expect(screen.getAllByText(STALE_OFFER_LABEL)).toHaveLength(1); // Falcon's only
  });

  it("surfaces a send failure inline and keeps the dialog open to retry", async () => {
    const { onOpenChange } = renderDialog({
      impl: () => new ApiError(409, "Another leg is already pending approval"),
    });

    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/));
    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already pending approval/i);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  // ── A9 (design §9) — carried over from `ShortlistDialog` ─────────────────────────────────────
  //
  // `handleSend`'s A9 guard is ONE disjunction — `leg.awaitingReQuote && (!proceed ||
  // !proceedReason.trim())` — so it has two independent failure modes. Final whole-branch review,
  // IMPORTANT 2: only the first was ever covered, and even that coverage was never a per-mode
  // falsification. Task 3 retitled that test "requires the A9 reason even with proceed-without-
  // waiting left unticked" but left its body alone, and the body never ticks the box or types a
  // reason — `!proceed` short-circuits, so deleting the reason half of the guard outright left all
  // 859 web tests green (confirmed).
  //
  // The second case below closes the reason half: it ticks the box and types a spaces-only reason,
  // so `!proceedReason.trim()` is the only disjunct left standing — mutating it away (see the
  // comment above that test) turns it red. That half is now genuinely falsifiable.
  //
  // The checkbox half (`!proceed`) is still NOT, re-verified directly: deleting `!proceed` outright
  // — leaving `leg.awaitingReQuote && !proceedReason.trim()` — leaves this file's 18 tests green,
  // "first failure mode" included, because that test never fills in a reason either; the blank
  // reason refuses the send on its own regardless of what `!proceed` says. Isolating `!proceed`
  // would need a case with the box left UNTICKED but a non-blank reason typed in, which no test
  // here provides. Both tests below assert the A9 message TEXT (a bare `findByRole("alert")` was
  // also satisfied by the override-reason error and by the mutation error alert) and each pins the
  // precondition that sets up its scenario — but only the second pins one that actually falsifies
  // the term it names.
  it("refuses the send while proceed-without-waiting is unticked (A9, first failure mode)", async () => {
    renderDialog({ leg: { ...LEG, awaitingReQuote: true } });
    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/));

    // The mode under test: the box is genuinely unticked.
    expect(screen.getByRole("checkbox", { name: /proceed without waiting/i })).not.toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /give a reason before sending this leg for approval/i,
    );
    expect(postJson).not.toHaveBeenCalled();
  });

  // Mutation-proven (final review, IMPORTANT 2): weakening the guard to `leg.awaitingReQuote &&
  // !proceed` — i.e. deleting the reason requirement — turns THIS test red (the send goes through
  // with an empty `proceedReason`) while every other web test stays green.
  it("refuses the send when proceed-without-waiting is ticked but the reason is blank (A9, second failure mode)", async () => {
    renderDialog({ leg: { ...LEG, awaitingReQuote: true } });
    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/));

    const checkbox = screen.getByRole("checkbox", { name: /proceed without waiting/i });
    await userEvent.click(checkbox);
    // The mode under test: the FIRST disjunct is now satisfied, so only the reason can refuse.
    expect(checkbox).toBeChecked();
    // Whitespace, not emptiness — the guard reads `.trim()`, and a spaces-only reason is exactly
    // the input that separates the two.
    await userEvent.type(screen.getByLabelText(/^reason$/i), "   ");

    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /give a reason before sending this leg for approval/i,
    );
    expect(postJson).not.toHaveBeenCalled();
  });

  // ── S5.9.2 product item 9 (PO ruling) — the reason field renders ALWAYS, not only once the
  // "Proceed without waiting" box is ticked; only the requirement (enforced above) was ever
  // conditional. Mutation-proved: reintroducing the deleted `{proceed && (...)}` wrapper around
  // the reason `Textarea` in `SendForApprovalDialog.tsx` makes this red (the field disappears
  // before the box is ticked); removing the wrapper again turns it green (task-3-report.md).
  it("shows the A9 reason field before proceed-without-waiting is ticked, marked required", async () => {
    renderDialog({ leg: { ...LEG, awaitingReQuote: true } });
    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/));

    const reason = await screen.findByLabelText(/^reason$/i);
    expect(reason).toBeInTheDocument();
    expect(reason).toBeRequired();

    // Review round (Minor) — `handleSend` blocks on BOTH `!proceed` and `!proceedReason.trim()`;
    // the checkbox's own requirement must be visible too, not just the reason's, or a maker who
    // fills in the reason but leaves the box unticked only learns it was mandatory after Send.
    const checkbox = screen.getByRole("checkbox", { name: /proceed without waiting/i });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAttribute("aria-required", "true");
  });

  it("sends the A9 confirmation once the box is ticked and a reason given", async () => {
    renderDialog({ leg: { ...LEG, awaitingReQuote: true } });
    await userEvent.click(screen.getByLabelText(/Bridge Logistics — Dedicated/));
    await userEvent.click(screen.getByRole("checkbox", { name: /proceed without waiting/i }));
    await userEvent.type(screen.getByLabelText(/^reason$/i), "Deadline is today; cannot wait.");
    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));

    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(postJsonMock.mock.calls[0][0]).toBe(SEND_URL);
    expect(postJsonMock.mock.calls[0][1]).toEqual({
      quoteId: recommendedQuoteId,
      variant: "DEDICATED",
      proceedWithoutWaiting: true,
      proceedReason: "Deadline is today; cannot wait.",
    });
  });

  // ── Ported from ShortlistDialog.test.tsx's "the offer submitted is the offer whose Select was
  // clicked" block — the S5.6 Critical must stay dead. That dialog acted on a single `cell` prop
  // set by a grid click; this one has no such prop at all, only its own `RadioGroup` selection, so
  // the "elsewhere" a stale submission could come from is now the leg's PERSISTED shortlist
  // (`LEG.decision.shortlistedQuoteId`, pinned to Bridge above) rather than a rival grid click —
  // the fixture deliberately leaves that persisted value pointed at a DIFFERENT offer than the one
  // selected below, so a regression that reads the decision instead of the checked radio would be
  // caught here.
  //
  // Review round IMPORTANT 1 — the original `ShortlistDialog.test.tsx` block this was ported from
  // used `toEqual` here specifically (review fix F1) because `toMatchObject` lets a dropped
  // `overrideReason` pass silently — the port used `toMatchObject` and lost that coverage (the
  // reviewer proved it: deleting the `overrideReason` spread from `handleSend` left the whole
  // 131-test compare suite green). Restored to `toEqual`, asserting the FULL body, plus the
  // request URL (IMPORTANT 2 — nothing in this file asserted it before). ─────────────────────────
  it("submits the offer that is selected in the dialog, not one merely read elsewhere", async () => {
    renderDialog();
    await userEvent.click(screen.getByLabelText(/Oceanic — Groupage/));
    await userEvent.type(screen.getByLabelText(/override reason/i), "Better transit time");
    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));
    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(postJsonMock.mock.calls[0][0]).toBe(SEND_URL);
    expect(postJsonMock.mock.calls[0][1]).toEqual({
      quoteId: oceanicQuoteId,
      variant: "GROUPAGE",
      overrideReason: "Better transit time",
    });
  });
});
