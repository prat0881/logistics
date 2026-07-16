import { describe, it, expect, vi, beforeEach } from "vitest";
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

  it("shows API and DB as ok", async () => {
    renderWithClient();
    const okBadges = await screen.findAllByText("ok");
    expect(okBadges).toHaveLength(2);
  });
});
