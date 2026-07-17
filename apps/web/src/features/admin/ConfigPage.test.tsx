import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigPage } from "./ConfigPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderConfig() {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/config/density-factors"))
        return {
          status: 200,
          body: [
            { mode: "ROAD", kgPerCbm: 333 },
            { mode: "AIR", kgPerCbm: 167 },
            { mode: "SEA", kgPerCbm: 1000 },
          ],
        };
      if (url.endsWith("/api/config/checklist-definition"))
        return {
          status: 200,
          body: [
            {
              itemKey: "weight-confirmed",
              label: "Weight confirmed",
              order: 1,
              dgConditional: false,
            },
            { itemKey: "msds-received", label: "MSDS received", order: 5, dgConditional: true },
          ],
        };
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfigPage />
    </QueryClientProvider>,
  );
}

describe("ConfigPage", () => {
  it("renders seeded density factors including SEA=1000", async () => {
    renderConfig();
    await waitFor(() => expect(screen.getByText("SEA")).toBeInTheDocument());
    expect(screen.getByDisplayValue("1000")).toBeInTheDocument();
    expect(screen.getByText("ROAD")).toBeInTheDocument();
    expect(screen.getByDisplayValue("333")).toBeInTheDocument();
    expect(screen.getByText("AIR")).toBeInTheDocument();
    expect(screen.getByDisplayValue("167")).toBeInTheDocument();
  });

  it("renders the missing-details checklist, flagging DG-only items", async () => {
    renderConfig();
    await waitFor(() => expect(screen.getByText("Weight confirmed")).toBeInTheDocument());
    expect(screen.getByText("MSDS received (DG only)")).toBeInTheDocument();
  });
});
