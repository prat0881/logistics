import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HealthStatus } from "./HealthStatus";

function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HealthStatus />
    </QueryClientProvider>,
  );
}

describe("HealthStatus", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const body = url.endsWith("/db") ? { status: "ok", db: "ok" } : { status: "ok" };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows API and DB as ok", async () => {
    renderWithClient();
    const okBadges = await screen.findAllByText("ok");
    expect(okBadges).toHaveLength(2);
  });

  it("shows a neutral checking state while the queries are loading, not an error", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderWithClient();

    const checkingBadges = screen.getAllByText("checking…");
    expect(checkingBadges).toHaveLength(2);
    expect(screen.queryByText("ok")).not.toBeInTheDocument();
    expect(screen.queryByText("error")).not.toBeInTheDocument();
  });
});
