import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { QuotationDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import { QuotationPreviewDialog } from "./QuotationPreviewDialog";

afterEach(() => vi.unstubAllGlobals());

/**
 * A realistic rendering of the seeded `quotation.issued.email` template (verbatim copy in
 * `apps/api/src/seed/message-templates.seed.ts`) — the client's own enquiry particulars plus ONE
 * grand total, nothing else. `previewBody`/`previewSubject` are exactly what `QuotationService
 * .toDto` computes server-side (S5.8 Task 6); this fixture stands in for that response so the
 * dialog can be tested without a live backend. `pricing` deliberately carries the WITHHELD figures
 * (forwarder name, cost total, a charge-line label) so the withheld-content test has something
 * real to prove is absent from the rendered letter, even though the dialog never reads `pricing`
 * itself.
 */
const QUOTATION: QuotationDto = {
  id: "quo1",
  queryId: "q1",
  version: 2,
  status: "DRAFT",
  marginPct: 18,
  overrides: {},
  pricing: {
    legs: [
      {
        legId: "l1",
        legCode: "LEG-1",
        forwarderName: "Bridge Logistics",
        variantLabel: "Dedicated",
        groups: [
          {
            group: "ORIGIN",
            label: "Origin charges",
            lines: [
              {
                id: "ORIGIN:0",
                group: "ORIGIN",
                label: "Terminal handling",
                costNative: 4539.08,
                costUsd: 4539.08,
                clientUsd: 5356.11,
                overridden: false,
              },
            ],
            costUsd: 4539.08,
            clientUsd: 5356.11,
          },
        ],
        costUsd: 4539.08,
        clientUsd: 5356.11,
      },
    ],
    costTotalUsd: 4539.08,
    clientTotalUsd: 5356.11,
    marginValueUsd: 817.03,
  },
  validUntil: "2026-09-01T00:00:00.000Z",
  previewSubject: "Quotation YAL26-0001-Q2 · Ref YAL26-0001",
  previewBody: [
    "Dear Acme Ltd,",
    "",
    "Thank you for your enquiry. We are pleased to quote for the shipment below.",
    "",
    "Our reference: YAL26-0001",
    "Your reference: PO-88431",
    "Shipment: 20 pallets of machine parts",
    "Vessel: MV Test (IMO 1234567)",
    "Port of call: Jebel Ali",
    "Cargo: 3 packages, 820 kg gross",
    "Cargo ready: 2026-08-25",
    "Quotation valid until: 2026-09-01",
    "",
    "Total — all inclusive: USD 5,356.11",
    "",
    "Covers all charges for the scope described above, subject to space and equipment availability at the time of booking and to the validity date shown.",
    "",
    "To proceed, simply reply to this email and we will confirm the booking.",
    "",
    "Regards,",
    "Yankalfa Logistics",
  ].join("\n"),
  recipientEmail: null,
  subject: null,
  bodyText: null,
  issuedAt: null,
  issuedByUserId: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

function renderDialog(
  opts: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultRecipientEmail?: string;
    quotation?: QuotationDto;
    onIssuePost?: (body: unknown) => void;
    issueResponse?: { status: number; body?: unknown };
  } = {},
) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith("/api/queries/q1/quotation/issue") && init?.method === "POST") {
        const body = init.body ? JSON.parse(init.body as string) : undefined;
        opts.onIssuePost?.(body);
        return opts.issueResponse ?? { status: 200, body: { ...(opts.quotation ?? QUOTATION), status: "ISSUED" } };
      }
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <QuotationPreviewDialog
        open={opts.open ?? true}
        onOpenChange={opts.onOpenChange ?? vi.fn()}
        queryId="q1"
        quotation={opts.quotation ?? QUOTATION}
        defaultRecipientEmail={opts.defaultRecipientEmail ?? "buyer@client.test"}
      />
    </QueryClientProvider>,
  );
}

describe("QuotationPreviewDialog", () => {
  it("shows the client's own enquiry particulars and one grand total", async () => {
    renderDialog();
    const letter = await screen.findByTestId("quotation-letter");
    expect(letter).toHaveTextContent("USD 5,356.11");
    expect(letter).toHaveTextContent("PO-88431");
  });

  // The commercial guard for the whole feature (S5.8 Task 6) — mutation-proven separately by
  // temporarily rendering a withheld figure into the letter and confirming this goes red.
  it("never renders forwarder cost, margin, charge lines or forwarder names", async () => {
    renderDialog();
    const letter = await screen.findByTestId("quotation-letter");
    expect(letter).not.toHaveTextContent("Bridge Logistics");
    expect(letter).not.toHaveTextContent("4,539.08"); // the withheld cost total
    expect(letter).not.toHaveTextContent(/margin/i);
    expect(letter).not.toHaveTextContent("Terminal handling"); // a charge-line label
  });

  it("prefills the recipient from the query contact and allows editing it", async () => {
    renderDialog({ defaultRecipientEmail: "buyer@client.test" });
    const recipient = await screen.findByLabelText("Recipient");
    expect(recipient).toHaveValue("buyer@client.test");

    await userEvent.clear(recipient);
    await userEvent.type(recipient, "new-contact@client.test");
    expect(recipient).toHaveValue("new-contact@client.test");
  });

  // Corrected from the (now out-of-date) brief: `quotationIssueSchema` has no `bodyText` field —
  // the letter is always rendered server-side — so issuing posts ONLY recipient + subject.
  it("issue posts recipient and subject only — never a body — then closes", async () => {
    const bodies: unknown[] = [];
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange, onIssuePost: (b) => bodies.push(b) });

    await userEvent.click(screen.getByRole("button", { name: /issue quotation/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      recipientEmail: "buyer@client.test",
      subject: QUOTATION.previewSubject,
    });
    expect(Object.keys(bodies[0] as Record<string, unknown>)).not.toContain("bodyText");

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("surfaces an issue failure inline and keeps the dialog open", async () => {
    const onOpenChange = vi.fn();
    renderDialog({
      onOpenChange,
      issueResponse: { status: 409, body: { message: "this quotation has already been issued" } },
    });

    await userEvent.click(screen.getByRole("button", { name: /issue quotation/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already been issued/i);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("states plainly that delivery is pending, and labels the action Issue — not Send", async () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /issue quotation/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/deliver/i)).toBeInTheDocument();
  });

  it("Back to builder closes the dialog without issuing", async () => {
    const onOpenChange = vi.fn();
    const onIssuePost = vi.fn();
    renderDialog({ onOpenChange, onIssuePost });

    await userEvent.click(screen.getByRole("button", { name: /back to builder/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onIssuePost).not.toHaveBeenCalled();
  });
});
