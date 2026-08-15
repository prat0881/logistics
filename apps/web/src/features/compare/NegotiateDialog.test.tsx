import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NegotiateDialog, type NegotiateDialogProps } from "./NegotiateDialog";

afterEach(() => vi.unstubAllGlobals());

type FetchResponse = { status: number; body?: unknown };
type Resolver = (value: FetchResponse) => void;

/** A fetch stub whose `/request-requote` response for a given `quoteId` only resolves once the
 *  test explicitly triggers it — lets a test observe mid-flight (`isPending`) state and control
 *  the order two different quotes' requests settle in (the plain `mockFetch` helper always
 *  resolves on the next microtask, too fast to ever observe "pending"). */
function deferredFetch() {
  const resolvers = new Map<string, Resolver>();
  const fetchFn = vi.fn((url: string) => {
    const match = url.match(/\/quotes\/([^/]+)\/request-requote$/);
    if (!match) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });
    }
    return new Promise((resolve) => {
      resolvers.set(match[1], (value: FetchResponse) =>
        resolve({
          ok: value.status >= 200 && value.status < 300,
          status: value.status,
          json: () => Promise.resolve(value.body ?? {}),
          text: () => Promise.resolve(JSON.stringify(value.body ?? {})),
        }),
      );
    });
  });
  return {
    fetchFn,
    resolve: (quoteId: string, value: FetchResponse) => resolvers.get(quoteId)?.(value),
  };
}

function renderDialog(qc: QueryClient, props: Partial<NegotiateDialogProps> & { onOpenChange: (v: boolean) => void }) {
  return render(
    <QueryClientProvider client={qc}>
      <NegotiateDialog
        open
        queryId="q1"
        legId="leg-1"
        quoteId="quote-1"
        freightForwarderName="TCI Freight"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("NegotiateDialog", () => {
  it("disables Cancel and refuses Escape while a request is pending", async () => {
    const { fetchFn } = deferredFetch();
    vi.stubGlobal("fetch", fetchFn);
    const onOpenChange = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog(qc, { onOpenChange });

    await userEvent.type(screen.getByLabelText(/comment/i), "Please revise.");
    await userEvent.click(screen.getByRole("button", { name: /request re-quote/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled());

    // A disabled Cancel is a no-op click by native <button> semantics; Escape is Radix's own
    // dismiss path, funnelled through the SAME `onOpenChange` this component gates.
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await userEvent.keyboard("{Escape}");

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("a stale success for the previous quote does not close the dialog once it has moved on to a different one", async () => {
    // This scenario is unreachable through MakerPanel's real UI (its trigger buttons sit behind
    // the modal overlay, and this component's own `handleOpenChange` blocks every close path
    // while pending — see NegotiateDialog.tsx's doc comments), so this test drives the component
    // directly and re-renders it with a new `quoteId` while the FIRST request is still in flight,
    // bypassing that outer guard on purpose to verify THIS component's own defence
    // (`latestQuoteId`) holds independently, not only as a side effect of the outer one.
    const { fetchFn, resolve } = deferredFetch();
    vi.stubGlobal("fetch", fetchFn);
    const onOpenChange = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderDialog(qc, { onOpenChange, quoteId: "quote-1" });

    await userEvent.type(screen.getByLabelText(/comment/i), "Please revise.");
    await userEvent.click(screen.getByRole("button", { name: /request re-quote/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled());

    rerender(
      <QueryClientProvider client={qc}>
        <NegotiateDialog
          open
          onOpenChange={onOpenChange}
          queryId="q1"
          legId="leg-1"
          quoteId="quote-2"
          freightForwarderName="Globex Logistics"
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: /negotiate with globex logistics/i })).toBeInTheDocument();

    // Settle quote-1's request now that the dialog has moved on to quote-2 — its stale
    // `onSuccess` must not fire a close. "Request re-quote" flipping back to enabled (this
    // component's ONE `useMutation` observer instance still tracks that same in-flight call,
    // regardless of the `quoteId` prop it was re-rendered with) is the observable proxy for "the
    // request has settled", so waiting for it avoids an arbitrary sleep.
    resolve("quote-1", { status: 200, body: { id: "quote-1", status: "REQUOTED" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /request re-quote/i })).not.toBeDisabled());

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("heading", { name: /negotiate with globex logistics/i })).toBeInTheDocument();
  });
});
