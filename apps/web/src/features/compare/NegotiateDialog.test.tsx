import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LegComparisonDto } from "@svyft/shared";
import { NegotiateDialog, type NegotiateDialogProps } from "./NegotiateDialog";

afterEach(() => vi.unstubAllGlobals());

// Bridge Forwarding prices BOTH Road variants off one submitted quote (`q-bridge`) — mirrors
// ComparisonGrid.test.tsx's own "one Quote, two variant rows" fixture — so it is the dedup case:
// the eligibility list must show ONE Bridge entry/checkbox, and a batch send must fire exactly one
// request for it, never two. Falcon Cargo is the second, single-offer eligible forwarder (also the
// one the partial-success test fails). Zenith Freight is REQUOTED (an offer exists, but not a
// re-quotable one). Orion Shipping never quoted at all — it's in `pendingForwarders`, not `offers`.
const LEG: LegComparisonDto = {
  legId: "leg-1",
  legCode: "LEG-1",
  mode: "ROAD",
  origin: "Chennai",
  destination: "Mumbai",
  offers: [
    {
      quoteId: "q-bridge",
      freightForwarderId: "ff-bridge",
      freightForwarderName: "Bridge Forwarding",
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
      quoteId: "q-bridge",
      freightForwarderId: "ff-bridge",
      freightForwarderName: "Bridge Forwarding",
      variant: "GROUPAGE",
      variantLabel: "Groupage",
      priced: true,
      nativeTotal: 30000,
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 361.45,
      transitDays: 5,
      chargeableWeightKg: 500,
      validUntil: "2026-08-25T12:00:00.000Z",
      quoteStatus: "QUOTED",
      charges: [],
    },
    {
      quoteId: "q-falcon",
      freightForwarderId: "ff-falcon",
      freightForwarderName: "Falcon Cargo",
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
    {
      quoteId: "q-zenith",
      freightForwarderId: "ff-zenith",
      freightForwarderName: "Zenith Freight",
      variant: "DEDICATED",
      variantLabel: "Dedicated",
      priced: true,
      nativeTotal: 47000,
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 566.27,
      transitDays: 3,
      chargeableWeightKg: 500,
      validUntil: "2026-08-25T12:00:00.000Z",
      quoteStatus: "REQUOTED",
      charges: [],
    },
  ],
  pendingForwarders: [
    { freightForwarderId: "ff-orion", freightForwarderName: "Orion Shipping", quoteStatus: "RFQ_SENT" },
  ],
  awaitingReQuote: true,
  recommendation: null,
  decision: null,
  timeline: [],
};

// Separate fixture (not folded into LEG) so its extra forwarder can't shift the "select all" /
// dedup counts every other test in this file asserts against. Harbor Freight is PENDING_APPROVAL —
// D5 (S5.9 code review round 2): negotiate stays refused while a leg is under review, so this
// forwarder must render ineligible with its OWN reason text, distinct from REQUOTED's.
const LEG_WITH_PENDING_APPROVAL: LegComparisonDto = {
  ...LEG,
  offers: [
    ...LEG.offers,
    {
      quoteId: "q-harbor",
      freightForwarderId: "ff-harbor",
      freightForwarderName: "Harbor Freight",
      variant: "DEDICATED",
      variantLabel: "Dedicated",
      priced: true,
      nativeTotal: 44000,
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 530.12,
      transitDays: 3,
      chargeableWeightKg: 500,
      validUntil: "2026-08-25T12:00:00.000Z",
      quoteStatus: "PENDING_APPROVAL",
      charges: [],
    },
  ],
};

// S5.9.5 (D4) — Sable Lines is EXPIRED but still PRICED: the re-quote went unanswered and the
// sweep now keeps their earlier submitted price. `REQUOTABLE_STATUSES` (negotiation.service.ts)
// admits EXPIRED, so this forwarder must be selectable. Separate fixture, same reason as
// `LEG_WITH_PENDING_APPROVAL` above — it must not shift the dedup/"select all" counts other tests
// assert against.
const LEG_WITH_EXPIRED: LegComparisonDto = {
  ...LEG,
  offers: [
    ...LEG.offers,
    {
      quoteId: "q-sable",
      freightForwarderId: "ff-sable",
      freightForwarderName: "Sable Lines",
      variant: "DEDICATED",
      variantLabel: "Dedicated",
      priced: true,
      nativeTotal: 43000,
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 518.07,
      transitDays: 4,
      chargeableWeightKg: 500,
      validUntil: "2026-08-20T12:00:00.000Z",
      quoteStatus: "EXPIRED",
      charges: [],
    },
  ],
};

type FetchCall = { url: string; quoteId: string; body: unknown };

/** A fetch stub that records every `request-requote` call (so a test can assert exactly which
 *  quoteIds were hit and how many times — the dedup/loop-count proof) and can be told to fail a
 *  specific quoteId with a given status/message (the partial-success proof). Everything else
 *  404s. */
function createRequoteFetch(failFor: Record<string, { status: number; message: string }> = {}) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn((url: string, init?: RequestInit) => {
    const match = url.match(/\/quotes\/([^/]+)\/request-requote$/);
    if (!match) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as Response);
    }
    const quoteId = match[1];
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    calls.push({ url, quoteId, body });
    const failure = failFor[quoteId];
    if (failure) {
      return Promise.resolve({
        ok: false,
        status: failure.status,
        json: () => Promise.resolve({ message: failure.message }),
        text: () => Promise.resolve(JSON.stringify({ message: failure.message })),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: quoteId, status: "REQUOTED" }),
      text: () => Promise.resolve(JSON.stringify({ id: quoteId, status: "REQUOTED" })),
    } as Response);
  });
  return {
    fetchFn,
    calls,
    requotePaths: () => calls.map((c) => c.quoteId),
    lastFetchBody: (urlSubstring: string) =>
      JSON.stringify(calls.filter((c) => c.url.includes(urlSubstring)).at(-1)?.body),
  };
}

/** A fetch stub whose `request-requote` response for a given `quoteId` only resolves once the
 *  test explicitly triggers it — lets a test observe mid-flight (`isPending`) state (mirrors the
 *  single-forwarder dialog's own `deferredFetch`, S5.6). */
function deferredRequoteFetch() {
  const resolvers = new Map<string, (value: { status: number; body?: unknown }) => void>();
  const fetchFn = vi.fn((url: string) => {
    const match = url.match(/\/quotes\/([^/]+)\/request-requote$/);
    if (!match) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as Response);
    }
    return new Promise((resolve) => {
      resolvers.set(match[1], (value) =>
        resolve({
          ok: value.status >= 200 && value.status < 300,
          status: value.status,
          json: () => Promise.resolve(value.body ?? {}),
          text: () => Promise.resolve(JSON.stringify(value.body ?? {})),
        } as Response),
      );
    });
  });
  return {
    fetchFn,
    resolve: (quoteId: string, value: { status: number; body?: unknown }) =>
      resolvers.get(quoteId)?.(value),
  };
}

function renderDialog(
  qc: QueryClient,
  props: Partial<NegotiateDialogProps> & { onOpenChange: (v: boolean) => void },
) {
  return render(
    <QueryClientProvider client={qc}>
      <NegotiateDialog open queryId="q1" legId="leg-1" leg={LEG} {...props} />
    </QueryClientProvider>,
  );
}

function renderNegotiate(opts: { fetchFn?: ReturnType<typeof vi.fn>; onOpenChange?: (v: boolean) => void } = {}) {
  const onOpenChange = opts.onOpenChange ?? vi.fn();
  if (opts.fetchFn) vi.stubGlobal("fetch", opts.fetchFn);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderDialog(qc, { onOpenChange });
  return { onOpenChange, qc };
}

describe("NegotiateDialog", () => {
  it("lists eligible forwarders selectable and ineligible ones disabled with a reason", async () => {
    renderNegotiate();

    expect(await screen.findByRole("checkbox", { name: /bridge/i })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /falcon/i })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /zenith/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /orion/i })).toBeDisabled();
    expect(screen.getByText(/already awaiting a revised quote/i)).toBeInTheDocument();
    expect(screen.getByText(/hasn't quoted yet/i)).toBeInTheDocument();
  });

  // D5 (S5.9 code review round 2): negotiate stays REFUSED while a leg is under review — a
  // PENDING_APPROVAL offer must be disabled with its OWN reason, never conflated with REQUOTED's
  // "already awaiting a revised quote" text, and never silently hidden.
  it("a PENDING_APPROVAL offer is ineligible with its own reason — negotiate stays refused while a leg is under review (D5)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc, { onOpenChange: vi.fn(), leg: LEG_WITH_PENDING_APPROVAL });

    expect(await screen.findByRole("checkbox", { name: /harbor/i })).toBeDisabled();
    expect(screen.getByText(/this leg is pending approval — reject it first\./i)).toBeInTheDocument();
    // Distinct from REQUOTED's reason — proves the two ineligible states aren't conflated.
    expect(screen.getByText(/already awaiting a revised quote/i)).toBeInTheDocument();
  });

  // S5.9.5 (D4) — `REQUOTABLE_STATUSES` gained EXPIRED, so a priced expired offer is selectable
  // here. The old fallback reason ("Already awaiting a revised quote.") would have been plainly
  // false for it — nobody is waiting; the window closed unanswered.
  it("S5.9.5 (D4) — a priced EXPIRED forwarder is eligible, while the REQUOTED one stays disabled", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc, { onOpenChange: vi.fn(), leg: LEG_WITH_EXPIRED });

    expect(await screen.findByRole("checkbox", { name: /sable/i })).toBeEnabled();
    // Positive control in the same test: the REQUOTED sibling keeps the old treatment, so a bug
    // that enables every forwarder cannot pass this.
    expect(screen.getByRole("checkbox", { name: /zenith/i })).toBeDisabled();
  });

  // ── final review IMPORTANT #4 — design item 6 (§89): "a checkbox per forwarder, showing each
  // one's current price and status". Names alone shipped, and the dialog is modal, so the maker
  // chose who to renegotiate with while the grid's prices were covered.
  it("shows each forwarder's current price and quote status next to its checkbox", async () => {
    renderNegotiate();

    // Bridge prices BOTH Road variants off one quote — "its current price" is genuinely two
    // figures, and collapsing them into one would be inventing a number the read model doesn't have.
    const bridgePrice = await screen.findByTestId("negotiate-price-ff-bridge");
    expect(bridgePrice).toHaveTextContent("Dedicated $542.17");
    expect(bridgePrice).toHaveTextContent("Groupage $361.45");

    expect(screen.getByTestId("negotiate-price-ff-falcon")).toHaveTextContent("Dedicated $506.02");
    // An INELIGIBLE forwarder's price still shows — the maker needs to know what the one they
    // can't re-ask is currently charging.
    expect(screen.getByTestId("negotiate-price-ff-zenith")).toHaveTextContent("Dedicated $566.27");
    // Orion never quoted: no invented figure, and no `$0.00`.
    expect(screen.getByTestId("negotiate-price-ff-orion")).toHaveTextContent("No price yet");
    expect(screen.getByTestId("negotiate-price-ff-orion")).not.toHaveTextContent("$");

    // The status is the grid's own `ForwarderStatusBadge`, per forwarder — not a second vocabulary.
    const row = (name: RegExp) => screen.getByRole("checkbox", { name }).closest("li")!;
    expect(within(row(/bridge/i)).getByText("Quoted")).toBeInTheDocument();
    // S5.9.2 Q4 — "RFQ-Resent", never "Requoted" (the badge is shared with the grid).
    expect(within(row(/zenith/i)).getByText("RFQ-Resent")).toBeInTheDocument();
    expect(within(row(/orion/i)).getByText("RFQ Sent")).toBeInTheDocument();
  });

  it("posts one request per selected forwarder with the shared note", async () => {
    const { fetchFn, requotePaths, lastFetchBody } = createRequoteFetch();
    const user = userEvent.setup();
    renderNegotiate({ fetchFn });

    await user.click(await screen.findByRole("checkbox", { name: /select all/i }));
    await user.type(screen.getByLabelText(/^note$/i), "budget is $1,500");
    await user.click(screen.getByRole("button", { name: /send to 2 forwarders/i }));

    await waitFor(() => expect(requotePaths()).toHaveLength(2));
    // Deduplicated by forwarder — Bridge has TWO offers (Dedicated + Groupage) sharing `q-bridge`,
    // so exactly one request for it, not two.
    expect(requotePaths().sort()).toEqual(["q-bridge", "q-falcon"]);
    expect(JSON.parse(lastFetchBody("request-requote"))).toEqual({ comment: "budget is $1,500" });
  });

  // S5.9.2 product item 1 — the per-forwarder note toggle is gone; only ONE shared note exists
  // now, applied to every selected forwarder. Mutation-proved: restoring the deleted `Checkbox`
  // (`aria-label="Send a separate note per forwarder"`) turns this red; removing it again turns it
  // green (task-3-report.md).
  it("no longer offers a separate-notes toggle — one shared note applies to everyone selected", async () => {
    renderNegotiate();

    await screen.findByRole("checkbox", { name: /bridge/i }); // positive control — list has rendered
    expect(
      screen.queryByRole("checkbox", { name: /separate note/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/note for bridge/i)).not.toBeInTheDocument();
  });

  it("disables Send until every required note is filled in", async () => {
    const { fetchFn } = createRequoteFetch();
    const user = userEvent.setup();
    renderNegotiate({ fetchFn });

    await user.click(await screen.findByRole("checkbox", { name: /select all/i }));
    expect(screen.getByRole("button", { name: /send to 2 forwarders/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/^note$/i), "please revise");
    expect(screen.getByRole("button", { name: /send to 2 forwarders/i })).toBeEnabled();
  });

  // Fix round 1, MINOR #2 — the single-forwarder dialog this replaced enforced
  // `requestRequoteSchema`'s FULL bound (`.trim().min(1).max(2000)`) via `zodResolver`; the
  // rewrite only checked non-empty, silently dropping the max-length half.
  it("flags a note over 2000 characters and disables Send", async () => {
    const { fetchFn } = createRequoteFetch();
    renderNegotiate({ fetchFn });

    await userEvent.setup().click(await screen.findByRole("checkbox", { name: /bridge/i }));
    const sharedNote = screen.getByLabelText(/^note$/i);
    // `userEvent.type` drives one keystroke at a time — far too slow for 2000+ characters — so the
    // over-limit value is set directly, same as a paste would land in the controlled input.
    fireEvent.change(sharedNote, { target: { value: "a".repeat(2001) } });

    expect(await screen.findByText(/2000 characters or fewer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send to 1 forwarder/i })).toBeDisabled();

    // Trimming back under the limit clears the error and re-enables Send — proves this isn't
    // permanently stuck once it trips.
    fireEvent.change(sharedNote, { target: { value: "a".repeat(2000) } });
    expect(screen.queryByText(/2000 characters or fewer/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send to 1 forwarder/i })).toBeEnabled();
  });

  it("reports partial success per forwarder and stays open", async () => {
    const { fetchFn } = createRequoteFetch({
      "q-falcon": { status: 409, message: "Quote is not in a re-quotable state" },
    });
    const user = userEvent.setup();
    const { onOpenChange } = renderNegotiate({ fetchFn });

    await user.click(await screen.findByRole("checkbox", { name: /select all/i }));
    await user.type(screen.getByLabelText(/^note$/i), "please revise");
    await user.click(screen.getByRole("button", { name: /send to 2 forwarders/i }));

    expect(await screen.findByText(/bridge/i, { selector: "[data-result='ok']" })).toBeInTheDocument();
    expect(screen.getByText(/not in a re-quotable state/i)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // The narrowing that makes "retry just the failures" actually safe: Bridge already succeeded
    // (its FF-portal token/RFQ deadline were reissued server-side, not rolled back), so a second
    // Send must NOT re-fire against it — only Falcon, the one that actually failed, stays selected.
    // Without this, a careless retry silently reissues Bridge's token/deadline a second time.
    expect(screen.getByRole("checkbox", { name: /bridge/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /falcon/i })).toBeChecked();
    expect(screen.getByRole("button", { name: /send to 1 forwarder/i })).toBeInTheDocument();
  });

  it("closes once every selected forwarder's request succeeds", async () => {
    const { fetchFn } = createRequoteFetch();
    const user = userEvent.setup();
    const { onOpenChange } = renderNegotiate({ fetchFn });

    await user.click(await screen.findByRole("checkbox", { name: /select all/i }));
    await user.type(screen.getByLabelText(/^note$/i), "please revise");
    await user.click(screen.getByRole("button", { name: /send to 2 forwarders/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // ── final review MINOR #7 — a re-quote is not comparison-local ────────────────────────────────
  // `negotiation.service.ts` fires REOPEN_AWARD and moves the quote's status, which rolls up into
  // the LEG's status — and the leg card's `LegStatusBadge` is fed by `useQueryDetail`
  // (`["query", id]`), not by the comparison read model. The batch invalidated only
  // `["comparison"]`, leaving that badge stale on every leg it touched.
  it("invalidates the query detail as well as the comparison, so the leg status badge can't go stale", async () => {
    const { fetchFn } = createRequoteFetch();
    const user = userEvent.setup();
    const { qc } = renderNegotiate({ fetchFn });
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    await user.click(await screen.findByRole("checkbox", { name: /bridge/i }));
    await user.type(screen.getByLabelText(/^note$/i), "please revise");
    await user.click(screen.getByRole("button", { name: /send to 1 forwarder/i }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["query", "q1"] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["comparison", "q1"] });
  });

  it("resets selection and notes when the dialog re-opens", async () => {
    const { fetchFn } = createRequoteFetch();
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", fetchFn);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <NegotiateDialog open={false} onOpenChange={onOpenChange} queryId="q1" legId="leg-1" leg={LEG} />
      </QueryClientProvider>,
    );

    rerender(
      <QueryClientProvider client={qc}>
        <NegotiateDialog open onOpenChange={onOpenChange} queryId="q1" legId="leg-1" leg={LEG} />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("checkbox", { name: /bridge/i }));
    await user.type(screen.getByLabelText(/^note$/i), "a stray note");

    rerender(
      <QueryClientProvider client={qc}>
        <NegotiateDialog open={false} onOpenChange={onOpenChange} queryId="q1" legId="leg-1" leg={LEG} />
      </QueryClientProvider>,
    );
    rerender(
      <QueryClientProvider client={qc}>
        <NegotiateDialog open onOpenChange={onOpenChange} queryId="q1" legId="leg-1" leg={LEG} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("checkbox", { name: /bridge/i })).not.toBeChecked();
    expect(screen.getByLabelText(/^note$/i)).toHaveValue("");
  });

  it("disables Cancel and refuses Escape while a batch is in flight", async () => {
    const { fetchFn, resolve } = deferredRequoteFetch();
    const user = userEvent.setup();
    const { onOpenChange } = renderNegotiate({ fetchFn });

    await user.click(await screen.findByRole("checkbox", { name: /bridge/i }));
    await user.type(screen.getByLabelText(/^note$/i), "please revise");
    await user.click(screen.getByRole("button", { name: /send to 1 forwarder/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled());

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();

    resolve("q-bridge", { status: 200, body: { id: "q-bridge", status: "REQUOTED" } });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
