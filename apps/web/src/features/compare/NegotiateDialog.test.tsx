import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("sends a per-forwarder note when the separate-notes toggle is on", async () => {
    const { fetchFn, calls } = createRequoteFetch();
    const user = userEvent.setup();
    renderNegotiate({ fetchFn });

    await user.click(await screen.findByRole("checkbox", { name: /select all/i }));
    await user.click(screen.getByRole("checkbox", { name: /separate note/i }));

    await user.type(screen.getByLabelText(/note for bridge/i), "Bridge: sharpen the freight line.");
    await user.type(screen.getByLabelText(/note for falcon/i), "Falcon: match Bridge's rate.");
    await user.click(screen.getByRole("button", { name: /send to 2 forwarders/i }));

    await waitFor(() => expect(calls).toHaveLength(2));
    const byQuote = Object.fromEntries(calls.map((c) => [c.quoteId, c.body]));
    expect(byQuote["q-bridge"]).toEqual({ comment: "Bridge: sharpen the freight line." });
    expect(byQuote["q-falcon"]).toEqual({ comment: "Falcon: match Bridge's rate." });
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
