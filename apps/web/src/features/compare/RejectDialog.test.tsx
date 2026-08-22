import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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

function renderDialog({ impl }: { impl?: () => unknown } = {}) {
  postJsonMock.mockImplementation(() => {
    if (impl) {
      const result = impl();
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    }
    return Promise.resolve({ legId: LEG.legId, status: "REJECTED" });
  });

  const onOpenChange = vi.fn();
  renderWithProviders(<RejectDialog open onOpenChange={onOpenChange} queryId="q1" leg={LEG} />, {
    user: { id: "manager-1", name: "Manager", email: "m@x.com", role: "MANAGER" },
  });
  return { onOpenChange };
}

describe("RejectDialog", () => {
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

  it("blocks the form while the rejection is in flight", async () => {
    let resolveReject: (v: unknown) => void = () => {};
    renderDialog({
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

    resolveReject({ legId: LEG.legId, status: "REJECTED" });
    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));
  });
});
