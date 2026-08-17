import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { buildComparisonRowModel, offerKey } from "./comparisonRowModel";
import { ShortlistDialog } from "./ShortlistDialog";

afterEach(() => vi.unstubAllGlobals());

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────
// Two forwarders, one offer each. Bridge/DEDICATED IS the leg's recommendation; Falcon/GROUPAGE is
// not — so a pick of Falcon is exactly the "override reason required" case, and a pick of Bridge is
// exactly the "override box never touched" case that the `.optional()` resolver trap breaks.
const BRIDGE_DEDICATED: OfferDto = {
  quoteId: "q-bridge",
  freightForwarderId: "ff-bridge",
  freightForwarderName: "Bridge",
  variant: "DEDICATED",
  variantLabel: "Dedicated",
  priced: true,
  nativeTotal: 6700,
  currency: "AED",
  unitsPerUsd: 3.6725,
  usdTotal: 1824.37,
  transitDays: 3,
  chargeableWeightKg: 100,
  validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "QUOTED",
  charges: [],
};

const FALCON_GROUPAGE: OfferDto = {
  quoteId: "q-falcon",
  freightForwarderId: "ff-falcon",
  freightForwarderName: "Falcon",
  variant: "GROUPAGE",
  variantLabel: "Groupage",
  priced: true,
  nativeTotal: 5200,
  currency: "AED",
  unitsPerUsd: 3.6725,
  usdTotal: 1416.06,
  transitDays: 6,
  chargeableWeightKg: 100,
  validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "QUOTED",
  charges: [],
};

const LEG: LegComparisonDto = {
  legId: "leg-1",
  legCode: "LEG-1",
  mode: "ROAD",
  origin: "Chennai",
  destination: "Mumbai",
  offers: [BRIDGE_DEDICATED, FALCON_GROUPAGE],
  pendingForwarders: [],
  awaitingReQuote: false,
  recommendation: { quoteId: "q-bridge", variant: "DEDICATED", reason: "fastest transit" },
  decision: null,
  timeline: [],
};

type Decision = NonNullable<LegComparisonDto["decision"]>;

/** A DRAFT decision carrying whatever shortlist the caller wants PERSISTED on the leg — the second
 *  piece of state the S5.6 Critical drifted against. Every "ported unsavedPick" test below sets
 *  this to an offer OTHER than the one whose Select was clicked. */
function draftDecision(partial: Partial<Decision>): Decision {
  return {
    legId: "leg-1",
    status: "DRAFT",
    shortlistedQuoteId: null,
    shortlistedVariant: null,
    recommendedQuoteId: "q-bridge",
    recommendedVariant: "DEDICATED",
    overrideReason: null,
    rejectionReason: null,
    sentByUserId: null,
    sentForApprovalAt: null,
    decidedByUserId: null,
    decidedAt: null,
    ...partial,
  };
}

let fetchMock: ReturnType<typeof mockFetch>;

function calledPaths(): string[] {
  return fetchMock.mock.calls.map((c) => c[0] as string);
}

function lastFetchBody(path: string): string {
  const call = [...fetchMock.mock.calls].reverse().find((c) => (c[0] as string).includes(path));
  if (!call) throw new Error(`no fetch call matching ${path}; saw ${calledPaths().join(", ")}`);
  return (call[1] as RequestInit).body as string;
}

function renderDialog({
  offer,
  decision,
  awaitingReQuote = false,
  shortlistResponse,
  sendResponse,
}: {
  offer: OfferDto;
  decision?: Partial<Decision>;
  awaitingReQuote?: boolean;
  shortlistResponse?: { status: number; body?: unknown };
  sendResponse?: { status: number; body?: unknown };
}) {
  const leg: LegComparisonDto = {
    ...LEG,
    // `offer` may be a tweaked copy of a fixture (e.g. quoteStatus: "REQUOTED") — substitute it into
    // the leg by key so the row model, and therefore the cell handed to the dialog, reflects it.
    offers: LEG.offers.map((o) =>
      offerKey(o.quoteId, o.variant) === offerKey(offer.quoteId, offer.variant) ? offer : o,
    ),
    awaitingReQuote,
    decision: decision ? draftDecision(decision) : null,
  };
  // The cell comes out of the SAME row model the grid's Select button is built from — the dialog
  // can only ever act on an offer the grid actually rendered.
  const model = buildComparisonRowModel(leg, false);
  const cell = model.cells.find((c) => c.key === offerKey(offer.quoteId, offer.variant))!;

  fetchMock = mockFetch((url, init) => {
    if (url.endsWith("/api/queries/q1/legs/leg-1/shortlist") && init?.method === "PUT") {
      return shortlistResponse ?? { status: 200, body: { legId: "leg-1", status: "DRAFT" } };
    }
    if (url.endsWith("/api/queries/q1/legs/leg-1/send-for-approval") && init?.method === "POST") {
      return sendResponse ?? { status: 200, body: { legId: "leg-1", status: "PENDING_APPROVAL" } };
    }
    return { status: 404 };
  });
  vi.stubGlobal("fetch", fetchMock);

  const onOpenChange = vi.fn();
  renderWithProviders(
    <ShortlistDialog open onOpenChange={onOpenChange} queryId="q1" leg={leg} cell={cell} />,
    { user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" } },
  );
  return { onOpenChange };
}

describe("ShortlistDialog", () => {
  it("requires an override reason when the pick is not the recommendation", async () => {
    const user = userEvent.setup();
    renderDialog({ offer: FALCON_GROUPAGE }); // recommendation is BRIDGE_DEDICATED
    await user.click(await screen.findByRole("button", { name: /save & send for approval/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reason/i);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/shortlist"),
      expect.anything(),
    );
  });

  it("save & send posts shortlist then send-for-approval, in that order", async () => {
    const user = userEvent.setup();
    renderDialog({ offer: BRIDGE_DEDICATED }); // === the recommendation, no reason needed
    await user.click(screen.getByRole("button", { name: /save & send for approval/i }));
    await waitFor(() =>
      expect(calledPaths()).toEqual([
        expect.stringContaining("/shortlist"),
        expect.stringContaining("/send-for-approval"),
      ]),
    );
  });

  it("requires the A9 reason once proceed-without-waiting is ticked", async () => {
    const user = userEvent.setup();
    renderDialog({ offer: BRIDGE_DEDICATED, awaitingReQuote: true });
    await user.click(screen.getByRole("button", { name: /save & send for approval/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/shortlist"),
      expect.anything(),
    );
  });

  it("sends the A9 confirmation once the box is ticked and a reason given", async () => {
    const user = userEvent.setup();
    renderDialog({ offer: BRIDGE_DEDICATED, awaitingReQuote: true });
    await user.click(screen.getByRole("checkbox", { name: /proceed without waiting/i }));
    await user.type(screen.getByLabelText(/^reason$/i), "Deadline is today; cannot wait.");
    await user.click(screen.getByRole("button", { name: /save & send for approval/i }));

    await waitFor(() => expect(calledPaths()).toHaveLength(2));
    expect(JSON.parse(lastFetchBody("/send-for-approval"))).toEqual({
      proceedWithoutWaiting: true,
      proceedReason: "Deadline is today; cannot wait.",
    });
  });

  it("surfaces a 409 inline and keeps the dialog open", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({
      offer: BRIDGE_DEDICATED,
      shortlistResponse: { status: 409, body: { message: "This leg is not editable" } },
    });

    await user.click(screen.getByRole("button", { name: /save & send for approval/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not editable/i);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // Fail-safe sequencing: a failed shortlist must NEVER be followed by a send.
    expect(calledPaths().filter((p) => p.includes("/send-for-approval"))).toHaveLength(0);
  });

  // ── the S5.6 `.optional()` trap: `overrideReason` only accepts `undefined`, never "" ──────────
  // A `""` default makes zodResolver silently reject every submit of the RECOMMENDED offer — the
  // common path, and the one case that never renders the textarea at all, so there is nothing on
  // screen to explain the dead button. Mutation-proved by defaulting the field to "".
  it("posts the recommended offer with the override box never touched", async () => {
    const user = userEvent.setup();
    renderDialog({ offer: BRIDGE_DEDICATED });

    expect(screen.queryByLabelText(/override reason/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^save shortlist$/i }));

    await waitFor(() => expect(calledPaths()).toHaveLength(1));
    const body = JSON.parse(lastFetchBody("/shortlist"));
    expect(body).toEqual({ quoteId: "q-bridge", variant: "DEDICATED" });
    expect(body).not.toHaveProperty("overrideReason");
  });

  it("closes on a successful Save shortlist without sending for approval", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ offer: BRIDGE_DEDICATED });

    await user.click(screen.getByRole("button", { name: /^save shortlist$/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calledPaths().filter((p) => p.includes("/send-for-approval"))).toHaveLength(0);
  });

  // ── final review M2, carried over from the deleted shortlist radio ───────────────────────────
  it("warns that a REQUOTED offer's price is stale, without blocking the shortlist", async () => {
    const user = userEvent.setup();
    renderDialog({ offer: { ...BRIDGE_DEDICATED, quoteStatus: "REQUOTED" } });

    expect(await screen.findByText(/re-quote requested/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^save shortlist$/i }));
    await waitFor(() => expect(calledPaths()).toHaveLength(1));
  });

  it("shows no stale warning for a live QUOTED offer", () => {
    renderDialog({ offer: BRIDGE_DEDICATED });
    expect(screen.queryByText(/re-quote requested/i)).not.toBeInTheDocument();
  });

  it("names the offer it is acting on", async () => {
    renderDialog({ offer: FALCON_GROUPAGE });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Falcon");
    expect(dialog).toHaveTextContent("Groupage");
    expect(dialog).not.toHaveTextContent("Bridge");
  });
});

// ── ported S5.6 Critical (C1) coverage ────────────────────────────────────────────────────────
// These three replace the `unsavedPick` regression tests deleted with the guard itself (two from
// `MakerPanel.test.tsx`, the third — the grid seam — from `ComparisonGrid.test.tsx`, where its
// replacement stays because only that file mounts the real grid→dialog wiring).
//
// The original Critical: the grid's current pick and the PERSISTED shortlist lived in different
// components, so `POST /send-for-approval` (which carries no offer identity and re-reads
// `legAwardDecision.shortlistedQuoteId` server-side) could silently submit an offer other than the
// one on screen. The dialog removes the second piece of state — it acts on exactly one `OfferCell`
// — so the assertion is reframed: the offer submitted is the offer whose Select was clicked,
// whatever the leg happens to have persisted.
describe("ShortlistDialog — the offer submitted is the offer whose Select was clicked", () => {
  // Ported from MakerPanel.test.tsx "blocks Send for approval while the pick has moved off the
  // saved shortlist without being re-saved".
  it("submits the offer whose Select was clicked, not a previously shortlisted one", async () => {
    const user = userEvent.setup();
    renderDialog({
      offer: FALCON_GROUPAGE,
      decision: { shortlistedQuoteId: "q-bridge", shortlistedVariant: "DEDICATED" },
    });
    await user.type(screen.getByLabelText(/override reason/i), "cheaper");
    await user.click(screen.getByRole("button", { name: /^save shortlist$/i }));
    await waitFor(() => expect(calledPaths()).toHaveLength(1));
    const body = JSON.parse(lastFetchBody("/shortlist"));
    expect(body).toMatchObject({ quoteId: FALCON_GROUPAGE.quoteId, variant: "GROUPAGE" });
  });

  // Same drift, but down the send path — the one the Critical actually mis-awarded on. The send
  // POST still carries no offer identity, so the ONLY thing that makes it safe is that the
  // immediately-preceding shortlist PUT re-pointed the decision at the clicked offer.
  it("re-points the persisted shortlist at the clicked offer BEFORE sending for approval", async () => {
    const user = userEvent.setup();
    renderDialog({
      offer: FALCON_GROUPAGE,
      decision: { shortlistedQuoteId: "q-bridge", shortlistedVariant: "DEDICATED" },
    });
    await user.type(screen.getByLabelText(/override reason/i), "cheaper");
    await user.click(screen.getByRole("button", { name: /save & send for approval/i }));

    await waitFor(() =>
      expect(calledPaths()).toEqual([
        expect.stringContaining("/shortlist"),
        expect.stringContaining("/send-for-approval"),
      ]),
    );
    expect(JSON.parse(lastFetchBody("/shortlist"))).toMatchObject({
      quoteId: "q-falcon",
      variant: "GROUPAGE",
    });
  });

  // Ported from MakerPanel.test.tsx "blocks Send for approval when nothing has been shortlisted yet
  // (would be a guaranteed 400)". The old guard made Send unreachable in that state; the dialog
  // makes it impossible instead — Send is never issued without a shortlist PUT for the clicked
  // offer landing first.
  it("shortlists the clicked offer first even when the leg has no saved shortlist at all", async () => {
    const user = userEvent.setup();
    renderDialog({ offer: BRIDGE_DEDICATED }); // decision: null

    await user.click(screen.getByRole("button", { name: /save & send for approval/i }));

    await waitFor(() => expect(calledPaths()).toHaveLength(2));
    expect(calledPaths()[0]).toContain("/shortlist");
    expect(JSON.parse(lastFetchBody("/shortlist"))).toMatchObject({
      quoteId: "q-bridge",
      variant: "DEDICATED",
    });
    // The send endpoint carries no offer identity at all — that is precisely why the shortlist PUT
    // above has to be the thing that names the offer (carried over from MakerPanel.test.tsx's
    // "posts an empty body on Send for approval when nothing is awaiting a re-quote").
    expect(JSON.parse(lastFetchBody("/send-for-approval"))).toEqual({});
  });
});
