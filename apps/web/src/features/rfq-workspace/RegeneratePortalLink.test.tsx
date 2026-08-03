import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import * as clip from "@/lib/clipboard";
import { RegeneratePortalLink } from "./RegeneratePortalLink";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
};

describe("RegeneratePortalLink", () => {
  it("regenerates, auto-copies the new link, shows a transient confirmation, and shows no inline link field", async () => {
    const copySpy = vi.spyOn(clip, "copyToClipboard").mockResolvedValue(true);
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/reissue-token") && init?.method === "POST")
        return { status: 200, body: { rfqId: "r", rfqNumber: "Q-1-RFQ001", freightForwarderId: "ff1", accessToken: "NEWTOK" } };
      return { status: 404 };
    }));
    render(wrap(<RegeneratePortalLink queryId="q1" freightForwarderId="ff1" />));
    await userEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(expect.stringContaining("/ff/rfq/NEWTOK")));
    expect(await screen.findByText(/link copied/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/portal link/i)).toBeNull();
  });

  it("falls back to a visible, copyable link when the clipboard write fails", async () => {
    const copySpy = vi.spyOn(clip, "copyToClipboard").mockResolvedValue(false);
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/reissue-token") && init?.method === "POST")
        return { status: 200, body: { rfqId: "r", rfqNumber: "Q-1-RFQ001", freightForwarderId: "ff1", accessToken: "NEWTOK" } };
      return { status: 404 };
    }));
    render(wrap(<RegeneratePortalLink queryId="q1" freightForwarderId="ff1" />));
    await userEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(expect.stringContaining("/ff/rfq/NEWTOK")));
    const fallbackInput = await screen.findByLabelText(/portal link/i);
    expect((fallbackInput as HTMLInputElement).value).toContain("/ff/rfq/NEWTOK");
    expect(screen.queryByText(/link copied/i)).not.toBeInTheDocument();
  });

  it("clears a stale 'Link copied' confirmation when a repeat click's copy fails", async () => {
    const copySpy = vi
      .spyOn(clip, "copyToClipboard")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    let token = "NEWTOK1";
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/reissue-token") && init?.method === "POST")
        return { status: 200, body: { rfqId: "r", rfqNumber: "Q-1-RFQ001", freightForwarderId: "ff1", accessToken: token } };
      return { status: 404 };
    }));
    render(wrap(<RegeneratePortalLink queryId="q1" freightForwarderId="ff1" />));
    const button = screen.getByRole("button", { name: /regenerate/i });

    // First click: copy succeeds -> transient "Link copied" confirmation.
    await userEvent.click(button);
    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(expect.stringContaining("/ff/rfq/NEWTOK1")));
    expect(await screen.findByText(/link copied/i)).toBeInTheDocument();

    // Second click (within the 2s confirmation window): reissue succeeds again but
    // this copy fails. The stale "Link copied" confirmation from the first click
    // must not survive alongside the new fallback link.
    token = "NEWTOK2";
    await userEvent.click(button);
    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(expect.stringContaining("/ff/rfq/NEWTOK2")));
    const fallbackInput = await screen.findByLabelText(/portal link/i);
    expect((fallbackInput as HTMLInputElement).value).toContain("/ff/rfq/NEWTOK2");
    expect(screen.queryByText(/link copied/i)).not.toBeInTheDocument();
  });
});
