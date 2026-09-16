import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ChargeCatalogueListPage } from "./ChargeCatalogueListPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const WHARFAGE = {
  id: "line-1",
  key: "SEA_DEST_WHARFAGE",
  mode: "SEA",
  variant: "BOTH",
  category: "DESTINATION",
  label: "Wharfage Charges",
  isAdditional: true,
  tagKey: null,
  inputType: "PLAIN",
  sortOrder: 69,
  isActive: true,
};

// Real data: ROAD_WH_HANDLING has a null category (warehousing deferred) — must never render.
const ROAD_WH_HANDLING = {
  id: "line-2",
  key: "ROAD_WH_HANDLING",
  mode: "ROAD",
  variant: "BOTH",
  category: null,
  label: "Warehouse Handling",
  isAdditional: false,
  tagKey: null,
  inputType: "PLAIN",
  sortOrder: 10,
  isActive: true,
};

function authOk(role: string) {
  return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
}

function renderList(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  vi.stubGlobal("fetch", mockFetch(handler));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter>
          <ChargeCatalogueListPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("ChargeCatalogueListPage", () => {
  it("filters ROAD_WH_HANDLING out of the rendered list (null category, warehousing deferred)", async () => {
    renderList((url) => {
      if (url.endsWith("/api/auth/me")) return authOk("ADMINISTRATOR");
      if (url.endsWith("/api/charge-line-definitions/admin"))
        return { status: 200, body: [WHARFAGE, ROAD_WH_HANDLING] };
      return { status: 404 };
    });
    await waitFor(() => expect(screen.getByText("Wharfage Charges")).toBeInTheDocument());
    expect(screen.queryByText("Warehouse Handling")).not.toBeInTheDocument();
    expect(screen.queryByText("ROAD_WH_HANDLING")).not.toBeInTheDocument();
  });

  it("renders the empty state only when the fetch genuinely succeeds and returns nothing", async () => {
    renderList((url) => {
      if (url.endsWith("/api/auth/me")) return authOk("ADMINISTRATOR");
      if (url.endsWith("/api/charge-line-definitions/admin")) return { status: 200, body: [] };
      return { status: 404 };
    });
    expect(await screen.findByText("No charge lines yet.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a role-specific message on a 403, never the empty-catalogue message", async () => {
    renderList((url) => {
      if (url.endsWith("/api/auth/me")) return authOk("EXECUTIVE");
      if (url.endsWith("/api/charge-line-definitions/admin"))
        return { status: 403, body: { message: "Insufficient role" } };
      return { status: 404 };
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /needs administrator or manager access/i,
    );
    expect(screen.queryByText("No charge lines yet.")).not.toBeInTheDocument();
  });

  it("surfaces the server's message on a non-403 fetch failure, never the empty-catalogue message", async () => {
    renderList((url) => {
      if (url.endsWith("/api/auth/me")) return authOk("ADMINISTRATOR");
      if (url.endsWith("/api/charge-line-definitions/admin"))
        return { status: 500, body: { message: "Database unavailable" } };
      return { status: 404 };
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    expect(screen.queryByText("No charge lines yet.")).not.toBeInTheDocument();
  });

  it("surfaces the 409 in-use message from Delete instead of a generic failure", async () => {
    renderList((url, init) => {
      if (url.endsWith("/api/auth/me")) return authOk("ADMINISTRATOR");
      if (url.endsWith("/api/charge-line-definitions/admin"))
        return { status: 200, body: [WHARFAGE] };
      if (url.endsWith("/api/charge-line-definitions/line-1") && init?.method === "DELETE")
        return {
          status: 409,
          body: { message: "This charge line is in use on 3 legs and cannot be deleted. Deactivate it instead." },
        };
      return { status: 404 };
    });
    await waitFor(() => expect(screen.getByText("Wharfage Charges")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /delete wharfage charges/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /in use on 3 legs and cannot be deleted/i,
    );
    // The row must survive a refused delete, not disappear from the list.
    expect(screen.getByText("Wharfage Charges")).toBeInTheDocument();
  });

  it("drops the Input and Sort columns", async () => {
    renderList((url) => {
      if (url.endsWith("/api/auth/me")) return authOk("ADMINISTRATOR");
      if (url.endsWith("/api/charge-line-definitions/admin"))
        return { status: 200, body: [WHARFAGE] };
      return { status: 404 };
    });
    await screen.findByRole("table");
    expect(screen.queryByRole("columnheader", { name: /^input$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /^sort$/i })).not.toBeInTheDocument();
  });

  it("badges a non-PLAIN line beside its label", async () => {
    const HEAVY = { ...WHARFAGE, id: "line-3", key: "AIR_MAIN_HEAVY_WEIGHT", inputType: "HEAVY_WEIGHT_CALC" };
    renderList((url) => {
      if (url.endsWith("/api/auth/me")) return authOk("ADMINISTRATOR");
      if (url.endsWith("/api/charge-line-definitions/admin"))
        return { status: 200, body: [HEAVY] };
      return { status: 404 };
    });
    expect(await screen.findByText(/heavy-weight/i)).toBeInTheDocument();
  });

  // Must survive the rework — Stage-4 item 6 depends on it.
  it("still hides the uncategorised ROAD_WH_HANDLING row", async () => {
    renderList((url) => {
      if (url.endsWith("/api/auth/me")) return authOk("ADMINISTRATOR");
      if (url.endsWith("/api/charge-line-definitions/admin"))
        return { status: 200, body: [WHARFAGE, ROAD_WH_HANDLING] };
      return { status: 404 };
    });
    await screen.findByRole("table");
    expect(screen.queryByText("ROAD_WH_HANDLING")).not.toBeInTheDocument();
  });
});
