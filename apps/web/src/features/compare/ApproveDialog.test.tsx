import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";
import { renderWithProviders } from "@/test/renderWithProviders";
import { ApiError, postJson } from "@/lib/api";
import { ApproveDialog } from "./ApproveDialog";

// Same rationale as `SendForApprovalDialog.test.tsx` — `postJson` mocked directly rather than via
// the usual `mockFetch`/global-`fetch` stub, since this dialog issues exactly one call shape.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, postJson: vi.fn() };
});

const postJsonMock = vi.mocked(postJson);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const APPROVE_URL = "/api/queries/q1/legs/leg-1/approve";

const BRIDGE_OFFER: OfferDto = {
  quoteId: "quote-bridge",
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
  quoteStatus: "PENDING_APPROVAL",
  charges: [],
};

const OTHER_OFFER: OfferDto = {
  ...BRIDGE_OFFER,
  quoteId: "quote-other",
  freightForwarderId: "ff-other",
  freightForwarderName: "Other Forwarder",
};

const LEG: LegComparisonDto = {
  legId: "leg-1",
  legCode: "LEG-2",
  mode: "ROAD",
  origin: "Chennai",
  destination: "Mumbai",
  offers: [BRIDGE_OFFER, OTHER_OFFER],
  pendingForwarders: [],
  awaitingReQuote: false,
  recommendation: { quoteId: "quote-bridge", variant: "DEDICATED", reason: "Fastest transit." },
  decision: {
    legId: "leg-1",
    status: "PENDING_APPROVAL",
    shortlistedQuoteId: "quote-bridge",
    shortlistedVariant: "DEDICATED",
    recommendedQuoteId: "quote-bridge",
    recommendedVariant: "DEDICATED",
    overrideReason: null,
    rejectionReason: null,
    sentByUserId: "sender-1",
    sentForApprovalAt: "2026-08-14T09:00:00.000Z",
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
    return Promise.resolve({ legId: leg.legId, status: "APPROVED" });
  });

  const onOpenChange = vi.fn();
  renderWithProviders(<ApproveDialog open onOpenChange={onOpenChange} queryId="q1" leg={leg} />, {
    user: { id: "manager-1", name: "Manager", email: "m@x.com", role: "MANAGER" },
  });
  return { onOpenChange };
}

// Review round (Important) — every fixture above this point has `shortlistedQuoteId ===
// recommendedQuoteId`, so "names the shortlisted forwarder" and "names the recommended forwarder"
// were indistinguishable claims: swapping `ApproveDialog.tsx`'s source from the shortlisted pair to
// the recommended pair left every test in this file green. The two only actually diverge on the
// maker's OVERRIDE path — `overrideReason` exists precisely because the maker picked something
// other than the recommendation — which is exactly the production case a wrong read here would
// mis-name. `OVERRIDE_LEG` keeps the recommendation on Bridge Logistics but shortlists Other
// Forwarder instead, so a test asserting "the dialog names Other Forwarder, not Bridge Logistics"
// actually exercises which of the two fields the dialog reads.
const OVERRIDE_LEG: LegComparisonDto = {
  ...LEG,
  decision: {
    ...LEG.decision!,
    shortlistedQuoteId: "quote-other",
    shortlistedVariant: "DEDICATED",
    // recommendedQuoteId/recommendedVariant deliberately left on quote-bridge — the maker
    // overrode the recommendation, which is why overrideReason is populated below.
    overrideReason: "Bridge missed the RFQ deadline; Other Forwarder can still meet it.",
  },
};

describe("ApproveDialog", () => {
  it("names the shortlisted forwarder and variant in the confirmation", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/Bridge Logistics/);
    expect(dialog).toHaveTextContent(/Dedicated/);
    expect(dialog).toHaveTextContent("LEG-2");
  });

  it("names the SHORTLISTED forwarder, not the recommended one, once the maker has overridden the recommendation", () => {
    renderDialog({ leg: OVERRIDE_LEG });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/Other Forwarder/);
    expect(dialog).not.toHaveTextContent(/Bridge Logistics/);
  });

  it("does not call the mutation just by rendering open", () => {
    renderDialog();
    expect(postJson).not.toHaveBeenCalled();
  });

  it("calls approve with no body on OK, and closes on success", async () => {
    const { onOpenChange } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /^ok$/i }));

    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(postJsonMock.mock.calls[0][0]).toBe(APPROVE_URL);
    expect(postJsonMock.mock.calls[0][1]).toBeUndefined();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("cancelling calls onOpenChange(false) and never calls the mutation", async () => {
    const { onOpenChange } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(postJson).not.toHaveBeenCalled();
  });

  // ── The dialog's own explicit requirement: never approve something it cannot name. ─────────────
  it("says the shortlisted offer can't be identified and disables OK when it's missing from leg.offers", () => {
    renderDialog({ leg: { ...LEG, offers: [OTHER_OFFER] } });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/could not be identified/i);
    expect(screen.getByRole("button", { name: /^ok$/i })).toBeDisabled();
  });

  it("also disables OK when the leg carries no decision at all", () => {
    renderDialog({ leg: { ...LEG, decision: null } });
    expect(screen.getByRole("button", { name: /^ok$/i })).toBeDisabled();
  });

  it("surfaces a failure inline and keeps the dialog open to retry", async () => {
    const { onOpenChange } = renderDialog({
      impl: () => new ApiError(403, "SELF_APPROVAL"),
    });
    await userEvent.click(screen.getByRole("button", { name: /^ok$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/SELF_APPROVAL/i);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  // Review round (Minor) — this used to be titled "blocks Escape/overlay-close" but only asserted
  // the footer buttons were disabled, never actually pressed Escape — so `ApproveDialog.tsx`'s
  // `handleOpenChange` early-return (`if (!next && pending) return;`), which is what Escape/overlay/
  // corner-X all funnel through via Radix's `onOpenChange`, was never exercised. Fires Escape for
  // real and asserts on `onOpenChange` directly, the same signal `SendForApprovalDialog.test.tsx`'s
  // equivalent guard is proven with elsewhere in this codebase.
  it("blocks Escape from closing the dialog while the approval is in flight", async () => {
    let resolveApprove: (v: unknown) => void = () => {};
    const { onOpenChange } = renderDialog({
      impl: () =>
        new Promise((resolve) => {
          resolveApprove = resolve;
        }),
    });
    await userEvent.click(screen.getByRole("button", { name: /^ok$/i }));

    // Still mid-flight — both footer buttons are disabled, so the dialog can't be dismissed via
    // them either.
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /approving/i })).toBeDisabled();

    // The actual guard under test — Escape funnels through the SAME `onOpenChange` the footer
    // Cancel button does, so it must be blocked too, not just the button itself.
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    resolveApprove({ legId: LEG.legId, status: "APPROVED" });
    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
  });
});
