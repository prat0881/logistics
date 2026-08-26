import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LegComparisonDto } from "@svyft/shared";
import { renderWithProviders } from "@/test/renderWithProviders";
import { ApiError, postJson } from "@/lib/api";
import { RejectDialog } from "./RejectDialog";

// Same rationale as `SendForApprovalDialog.test.tsx`/`ApproveDialog.test.tsx` — `postJson` mocked
// directly rather than via the usual `mockFetch`/global-`fetch` stub.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, postJson: vi.fn() };
});

const postJsonMock = vi.mocked(postJson);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const REJECT_URL = "/api/queries/q1/legs/leg-1/reject";

const LEG: LegComparisonDto = {
  legId: "leg-1",
  legCode: "LEG-2",
  mode: "ROAD",
  origin: "Chennai",
  destination: "Mumbai",
  offers: [],
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

function renderDialog({ impl, leg = LEG }: { impl?: () => unknown; leg?: LegComparisonDto } = {}) {
  postJsonMock.mockImplementation(() => {
    if (impl) {
      const result = impl();
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    }
    return Promise.resolve({ legId: LEG.legId, status: "REJECTED" });
  });

  const onOpenChange = vi.fn();
  renderWithProviders(<RejectDialog open onOpenChange={onOpenChange} queryId="q1" leg={leg} />, {
    user: { id: "manager-1", name: "Manager", email: "m@x.com", role: "MANAGER" },
  });
  return { onOpenChange };
}

describe("RejectDialog", () => {
  // ── S5.9.5 final whole-branch review, MINOR ───────────────────────────────────────────────
  it("says the approval is being reversed when the decision is APPROVED, and does not say so otherwise", () => {
    // D2 gave reject() a second mode: on an APPROVED decision it REVERSES the approval, and D1
    // makes it the only door out. The dialog's description covered only the PENDING_APPROVAL mode,
    // so a checker undoing a decision was told only that the maker gets it back to revise.
    const approvedLeg: LegComparisonDto = {
      ...LEG,
      decision: {
        ...LEG.decision!,
        status: "APPROVED",
        decidedByUserId: "manager-1",
        decidedAt: "2026-08-15T09:00:00.000Z",
      },
    };
    renderDialog({ leg: approvedLeg });
    expect(screen.getByText(/reverses the approval on this leg/i)).toBeInTheDocument();
    // Vocabulary rule D5 — "Approved", never "Awarded", on a reversal that is itself the proof
    // approval is provisional.
    expect(screen.queryByText(/award/i)).not.toBeInTheDocument();
    cleanup();

    // POSITIVE CONTROL — the original mode. The reversal sentence must be absent, or the new arm
    // would be indistinguishable from unconditionally rewording the copy.
    renderDialog();
    expect(screen.queryByText(/reverses the approval/i)).not.toBeInTheDocument();
    expect(screen.getByText(/sends the leg back to the maker to revise/i)).toBeInTheDocument();
  });

  it("does not call the mutation just by rendering open", () => {
    renderDialog();
    expect(postJson).not.toHaveBeenCalled();
  });

  it("blocks submit and shows a visible error when the reason is left empty", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /^reject$/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(postJson).not.toHaveBeenCalled();
  });

  it("posts the trimmed reason on submit, and closes on success", async () => {
    const { onOpenChange } = renderDialog();

    await userEvent.type(screen.getByLabelText(/rejection reason/i), "  Transit too long  ");
    await userEvent.click(screen.getByRole("button", { name: /^reject$/i }));

    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
    expect(postJsonMock.mock.calls[0][0]).toBe(REJECT_URL);
    expect(postJsonMock.mock.calls[0][1]).toEqual({ reason: "Transit too long" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("cancelling calls onOpenChange(false) and never calls the mutation", async () => {
    const { onOpenChange } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(postJson).not.toHaveBeenCalled();
  });

  it("surfaces a failure inline and keeps the dialog open to retry", async () => {
    const { onOpenChange } = renderDialog({
      impl: () => new ApiError(409, "Leg is not pending approval"),
    });

    await userEvent.type(screen.getByLabelText(/rejection reason/i), "Price too high");
    await userEvent.click(screen.getByRole("button", { name: /^reject$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not pending approval/i);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  // Review round (Minor) — same fix as `ApproveDialog.test.tsx`'s equivalent: this used to only
  // check the form's disabled state without ever pressing Escape, so `RejectDialog.tsx`'s
  // `handleOpenChange` early-return was never exercised. Fires Escape for real.
  it("blocks Escape from closing the dialog, and blocks the form, while the rejection is in flight", async () => {
    let resolveReject: (v: unknown) => void = () => {};
    const { onOpenChange } = renderDialog({
      impl: () =>
        new Promise((resolve) => {
          resolveReject = resolve;
        }),
    });

    await userEvent.type(screen.getByLabelText(/rejection reason/i), "Price too high");
    await userEvent.click(screen.getByRole("button", { name: /^reject$/i }));

    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /rejecting/i })).toBeDisabled();
    expect(screen.getByLabelText(/rejection reason/i)).toBeDisabled();

    // The actual guard under test — Escape funnels through the SAME `onOpenChange` the footer
    // Cancel button does, so it must be blocked too, not just the button itself.
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    resolveReject({ legId: LEG.legId, status: "REJECTED" });
    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
  });
});
