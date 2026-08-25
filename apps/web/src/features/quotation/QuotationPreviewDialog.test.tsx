import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { QuotationDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import * as clip from "@/lib/clipboard";
import { QuotationPreviewDialog } from "./QuotationPreviewDialog";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
  // S5.9.3 Task 1 (P1): the letter is now an editable textarea (`data-testid="quotation-letter"`),
  // seeded from `previewBody` — `toHaveValue`, not `toHaveTextContent`, is the correct matcher for
  // a form control (a controlled textarea's rendered value lives on the DOM node's `.value`
  // property, not as a text-node child, so `toHaveTextContent` would vacuously pass/fail here
  // regardless of what's actually in the box).
  it("shows the client's own enquiry particulars and one grand total, prefilled and editable", async () => {
    renderDialog();
    const letter = await screen.findByTestId("quotation-letter");
    expect(letter).toHaveValue(QUOTATION.previewBody);
    expect((letter as HTMLTextAreaElement).value).toContain("USD 5,356.11");
    expect((letter as HTMLTextAreaElement).value).toContain("PO-88431");

    await userEvent.type(letter, " Please confirm at your earliest convenience.");
    expect((letter as HTMLTextAreaElement).value).toContain(
      "Please confirm at your earliest convenience.",
    );
  });

  // The commercial guard for the whole feature (S5.8 Task 6) — mutation-proven separately by
  // temporarily rendering a withheld figure into the letter and confirming this goes red. P1 makes
  // this only a DEFAULT guarantee (the manager could in principle type these back in), which is
  // exactly why the server-side total in QuotationService.issue() stays independent of this text.
  it("never PREFILLS forwarder cost, margin, charge lines or forwarder names into the letter", async () => {
    renderDialog();
    const letter = await screen.findByTestId("quotation-letter");
    const value = (letter as HTMLTextAreaElement).value;
    expect(value).not.toContain("Bridge Logistics");
    expect(value).not.toContain("4,539.08"); // the withheld cost total
    expect(value.toLowerCase()).not.toContain("margin");
    expect(value).not.toContain("Terminal handling"); // a charge-line label
  });

  it("prefills the recipient from the query contact and allows editing it", async () => {
    renderDialog({ defaultRecipientEmail: "buyer@client.test" });
    const recipient = await screen.findByLabelText("Recipient");
    expect(recipient).toHaveValue("buyer@client.test");

    await userEvent.clear(recipient);
    await userEvent.type(recipient, "new-contact@client.test");
    expect(recipient).toHaveValue("new-contact@client.test");
  });

  // S5.9.3 Task 1 (P1) supersedes the S5.8 Task 6 contract: issuing now posts the (editable)
  // body too, defaulting to the prefilled `previewBody` when the manager never touches it.
  it("issue posts recipient, subject, and the prefilled body — then closes", async () => {
    const bodies: unknown[] = [];
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange, onIssuePost: (b) => bodies.push(b) });

    await userEvent.click(screen.getByRole("button", { name: /issue quotation/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      recipientEmail: "buyer@client.test",
      subject: QUOTATION.previewSubject,
      bodyText: QUOTATION.previewBody,
    });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // The single highest-risk behavior in this task (per the plan's self-review notes): an edit to
  // the letter must actually reach the wire, verbatim, rather than the dialog silently reverting
  // to the server's own render.
  it("an edited body reaches the issue request verbatim", async () => {
    const bodies: unknown[] = [];
    renderDialog({ onIssuePost: (b) => bodies.push(b) });

    const letter = await screen.findByTestId("quotation-letter");
    await userEvent.clear(letter);
    await userEvent.type(letter, "Dear Acme Ltd,\n\nA hand-typed offer.\n\nRegards.");

    await userEvent.click(screen.getByRole("button", { name: /issue quotation/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0] as { bodyText: string }).bodyText).toBe(
      "Dear Acme Ltd,\n\nA hand-typed offer.\n\nRegards.",
    );
  });

  // P1's explicit carve-out from `subject`'s own fallback-on-blank behavior: a genuinely empty
  // letter must never be silently swapped back for the server's render — the manager gets an
  // unambiguous "you cleared it", via the Issue action itself refusing to fire.
  it("refuses to issue an empty body — the Issue action disables rather than silently falling back", async () => {
    const bodies: unknown[] = [];
    renderDialog({ onIssuePost: (b) => bodies.push(b) });

    const letter = await screen.findByTestId("quotation-letter");
    const issueButton = screen.getByRole("button", { name: /issue quotation/i });
    expect(issueButton).not.toBeDisabled();

    await userEvent.clear(letter);
    expect(issueButton).toBeDisabled();

    // Mutation check: an attempted click while disabled must not somehow still fire the request.
    await userEvent.click(issueButton);
    expect(bodies).toHaveLength(0);
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

  // P3 — the product owner's report that "Copy text" reads and behaves as broken:
  // `handleCopy` used to swallow every error AND give no success signal, so a working copy and a
  // failed one were indistinguishable. Renamed, and now gives real feedback either way, reusing
  // the app's existing `copyToClipboard` (apps/web/src/lib/clipboard.ts) — the same helper
  // RegeneratePortalLink/PortalLinkRow already use for this exact problem.
  it('renames "Copy text" to "Copy to clipboard"', async () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy text" })).not.toBeInTheDocument();
  });

  it("shows a visible confirmation when the copy succeeds", async () => {
    const copySpy = vi.spyOn(clip, "copyToClipboard").mockResolvedValue(true);
    renderDialog();

    expect(screen.queryByText(/copied to clipboard/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(await screen.findByText(/copied to clipboard/i)).toBeInTheDocument();
    expect(copySpy).toHaveBeenCalledWith(QUOTATION.previewBody);
  });

  // Clipboard access can genuinely fail (non-secure context, denied permission) — `copyToClipboard`
  // models that as resolving `false` (see its own test suite), which must surface here as a
  // visible inline error, not silence.
  it("shows an inline error when the clipboard is unavailable", async () => {
    vi.spyOn(clip, "copyToClipboard").mockResolvedValue(false);
    renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(await screen.findByText(/couldn't copy/i)).toBeInTheDocument();
    expect(screen.queryByText(/copied to clipboard/i)).not.toBeInTheDocument();
  });

  it("copies the CURRENT (possibly edited) body, not the original template render", async () => {
    const copySpy = vi.spyOn(clip, "copyToClipboard").mockResolvedValue(true);
    renderDialog();

    const letter = await screen.findByTestId("quotation-letter");
    await userEvent.clear(letter);
    await userEvent.type(letter, "Edited letter text.");

    await userEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    await waitFor(() => expect(copySpy).toHaveBeenCalledWith("Edited letter text."));
  });
});
