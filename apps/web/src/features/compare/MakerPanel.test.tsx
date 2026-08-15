import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LegComparisonDto } from "@svyft/shared";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { MakerPanel } from "./MakerPanel";

afterEach(() => vi.unstubAllGlobals());

// A fresh leg (no decision yet) — two priced offers, TCI Freight is the recommendation.
const LEG: LegComparisonDto = {
  legId: "leg-1",
  legCode: "LEG-1",
  mode: "ROAD",
  origin: "Chennai",
  destination: "Mumbai",
  offers: [
    {
      quoteId: "quote-1",
      freightForwarderId: "ff1",
      freightForwarderName: "TCI Freight",
      variant: "DEDICATED",
      variantLabel: "Dedicated",
      priced: true,
      nativeTotal: 45000,
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 542.17,
      transitDays: 3,
      chargeableWeightKg: 500,
      validUntil: "2026-08-25T12:00:00.000Z",
      quoteStatus: "QUOTED",
      charges: [],
    },
    {
      quoteId: "quote-2",
      freightForwarderId: "ff2",
      freightForwarderName: "Globex Logistics",
      variant: "DEDICATED",
      variantLabel: "Dedicated",
      priced: true,
      nativeTotal: 42000,
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 506.02,
      transitDays: 4,
      chargeableWeightKg: 500,
      validUntil: "2026-08-22T12:00:00.000Z",
      quoteStatus: "QUOTED",
      charges: [],
    },
  ],
  pendingForwarders: [],
  awaitingReQuote: false,
  recommendation: { quoteId: "quote-1", variant: "DEDICATED", reason: "Fastest transit." },
  decision: null,
  timeline: [],
};

// A leg already sent for approval, shortlisted on the recommendation.
const PENDING_LEG: LegComparisonDto = {
  ...LEG,
  legId: "leg-2",
  legCode: "LEG-2",
  decision: {
    legId: "leg-2",
    status: "PENDING_APPROVAL",
    shortlistedQuoteId: "quote-1",
    shortlistedVariant: "DEDICATED",
    recommendedQuoteId: "quote-1",
    recommendedVariant: "DEDICATED",
    overrideReason: null,
    rejectionReason: null,
    sentByUserId: "u1",
    sentForApprovalAt: "2026-08-14T09:00:00.000Z",
    decidedByUserId: null,
    decidedAt: null,
  },
};

// A leg with an in-flight re-quote (A9 "proceed without waiting" path).
const AWAITING_LEG: LegComparisonDto = {
  ...LEG,
  legId: "leg-3",
  legCode: "LEG-3",
  awaitingReQuote: true,
  offers: [LEG.offers[0], { ...LEG.offers[1], quoteStatus: "REQUOTED" }],
};

/** Mirrors how `CompareLegPanel` will own the lifted shortlist-selection channel — MakerPanel
 *  itself never owns this piece of state (single source of truth lives in the parent). */
function Harness({ leg }: { leg: LegComparisonDto }) {
  const [shortlistKey, setShortlistKey] = useState<string | undefined>(undefined);
  return (
    <MakerPanel
      queryId="q1"
      leg={leg}
      shortlistKey={shortlistKey}
      onShortlistKeyChange={setShortlistKey}
    />
  );
}

function renderMaker(
  leg: LegComparisonDto,
  opts: {
    onShortlistPut?: (body: unknown) => void;
    sendResponse?: { status: number; body?: unknown };
    onSendPost?: (body: unknown) => void;
    onRequotePost?: (quoteId: string, body: unknown) => void;
  } = {},
) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith(`/api/queries/q1/legs/${leg.legId}/shortlist`) && init?.method === "PUT") {
        const body = JSON.parse((init.body as string) ?? "{}") as unknown;
        opts.onShortlistPut?.(body);
        return { status: 200, body: { legId: leg.legId, status: "DRAFT", ...(body as object) } };
      }
      if (
        url.endsWith(`/api/queries/q1/legs/${leg.legId}/send-for-approval`) &&
        init?.method === "POST"
      ) {
        const body = JSON.parse((init.body as string) ?? "{}") as unknown;
        opts.onSendPost?.(body);
        return opts.sendResponse ?? { status: 200, body: { legId: leg.legId, status: "PENDING_APPROVAL" } };
      }
      const requoteMatch = url.match(
        new RegExp(`/api/queries/q1/legs/${leg.legId}/quotes/([^/]+)/request-requote$`),
      );
      if (requoteMatch && init?.method === "POST") {
        const body = JSON.parse((init.body as string) ?? "{}") as unknown;
        opts.onRequotePost?.(requoteMatch[1], body);
        return { status: 200, body: { id: requoteMatch[1], status: "REQUOTED" } };
      }
      return { status: 404 };
    }),
  );
  return renderWithProviders(<Harness leg={leg} />, {
    user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" },
  });
}

describe("MakerPanel", () => {
  it("pre-selects the recommended offer and shows no override-reason field for it", () => {
    renderMaker(LEG);

    expect(screen.getByRole("radio", { name: /TCI Freight/i, checked: true })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Globex Logistics/i, checked: false }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/override reason/i)).not.toBeInTheDocument();
  });

  it("requires an override reason for a non-recommended pick and blocks Shortlist until one is entered", async () => {
    renderMaker(LEG);

    await userEvent.click(screen.getByRole("radio", { name: /Globex Logistics/i }));

    const overrideField = screen.getByLabelText(/override reason/i);
    expect(overrideField).toBeInTheDocument();

    const shortlistButton = screen.getByRole("button", { name: /^shortlist$/i });
    expect(shortlistButton).toBeDisabled();

    await userEvent.type(overrideField, "Cheaper and still within the transit window.");
    expect(shortlistButton).not.toBeDisabled();
  });

  it("PUTs the exact {quoteId, variant, overrideReason} body on Shortlist", async () => {
    const calls: unknown[] = [];
    renderMaker(LEG, { onShortlistPut: (body) => calls.push(body) });

    await userEvent.click(screen.getByRole("radio", { name: /Globex Logistics/i }));
    await userEvent.type(
      screen.getByLabelText(/override reason/i),
      "Cheaper and still within the transit window.",
    );
    await userEvent.click(screen.getByRole("button", { name: /^shortlist$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      quoteId: "quote-2",
      variant: "DEDICATED",
      overrideReason: "Cheaper and still within the transit window.",
    });
  });

  it("posts an empty body on Send for approval when nothing is awaiting a re-quote", async () => {
    const calls: unknown[] = [];
    renderMaker(LEG, { onSendPost: (body) => calls.push(body) });

    const sendButton = screen.getByRole("button", { name: /send for approval/i });
    expect(sendButton).not.toBeDisabled();
    await userEvent.click(sendButton);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({});
  });

  it("disables Send for approval once the decision is already pending approval", () => {
    renderMaker(PENDING_LEG);

    const sendButton = screen.getByRole("button", { name: /sent for approval/i });
    expect(sendButton).toBeDisabled();
  });

  it("surfaces a 409 from Send for approval inline", async () => {
    renderMaker(LEG, {
      sendResponse: { status: 409, body: { message: "This leg is not pending approval" } },
    });

    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not pending approval/i);
  });

  it("Negotiate opens the dialog and POSTs {comment} to the FF's quote", async () => {
    const calls: { quoteId: string; body: unknown }[] = [];
    renderMaker(LEG, {
      onRequotePost: (quoteId, body) => calls.push({ quoteId, body }),
    });

    await userEvent.click(screen.getByRole("button", { name: /negotiate.*tci freight/i }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText(/comment/i),
      "Can you sharpen the price by 5%?",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /request re-quote/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      quoteId: "quote-1",
      body: { comment: "Can you sharpen the price by 5%?" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("A9: requires an explicit proceed-without-waiting confirm + reason when the leg is awaiting a re-quote", async () => {
    const calls: unknown[] = [];
    renderMaker(AWAITING_LEG, { onSendPost: (body) => calls.push(body) });

    const sendButton = screen.getByRole("button", { name: /send for approval/i });
    expect(sendButton).toBeDisabled();

    await userEvent.click(screen.getByRole("checkbox", { name: /proceed without waiting/i }));
    expect(sendButton).toBeDisabled(); // still needs a reason

    await userEvent.type(screen.getByLabelText(/reason/i), "Deadline is today; cannot wait.");
    expect(sendButton).not.toBeDisabled();

    await userEvent.click(sendButton);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      proceedWithoutWaiting: true,
      proceedReason: "Deadline is today; cannot wait.",
    });
  });
});
