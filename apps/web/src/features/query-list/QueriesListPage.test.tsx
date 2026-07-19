import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route, useParams } from "react-router-dom";
import { QueriesListPage } from "./QueriesListPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

/** Renders the `:id` param so the test can assert which id the navigation used. */
function QueryWizardStub() {
  const { id } = useParams<{ id: string }>();
  return <div>wizard {id}</div>;
}

afterEach(() => vi.unstubAllGlobals());

const sampleRow = {
  id: "q1",
  queryCode: "YAL26-0001",
  queryDate: new Date().toISOString(),
  customerName: "Acme",
  contactName: "Al",
  shipmentDescription: "steel",
  freightMode: ["SEA"],
  origin: "Mumbai, IN",
  destination: "Rotterdam, NL",
  responseDeadline: null,
  priority: "HIGH",
  status: "DRAFT",
  assignedUserId: null,
  assignedUserName: "Exec",
  updatedAt: new Date().toISOString(),
};

const paginatedOne = { items: [sampleRow], total: 1, page: 1, pageSize: 20 };
const paginatedEmpty = { items: [], total: 0, page: 1, pageSize: 20 };

function setupFetch(rows = paginatedOne) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.includes("/api/auth/me"))
        return {
          status: 200,
          body: { user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" } },
        };
      if (url.includes("/api/queries")) return { status: 200, body: rows };
      return { status: 200, body: {} };
    }),
  );
}

describe("QueriesListPage", () => {
  it("renders rows and navigates on row click; shows + Create Query", async () => {
    setupFetch();
    renderWithProviders(
      <Routes>
        <Route path="/queries" element={<QueriesListPage />} />
        <Route path="/queries/:id" element={<QueryWizardStub />} />
      </Routes>,
      { route: "/queries" },
    );

    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create Query/i })).toHaveAttribute(
      "href",
      "/queries/new",
    );

    await userEvent.click(screen.getByText("YAL26-0001"));
    // Assert that the navigation used the row's actual id ("q1"), not just any text.
    expect(await screen.findByText("wizard q1")).toBeInTheDocument();
  });

  it("renders freightMode badges and assignedUserName", async () => {
    setupFetch();
    renderWithProviders(
      <Routes>
        <Route path="/queries" element={<QueriesListPage />} />
      </Routes>,
      { route: "/queries" },
    );

    expect(await screen.findByText("SEA")).toBeInTheDocument();
    expect(screen.getByText("Exec")).toBeInTheDocument();
  });

  it("shows empty state when no results", async () => {
    setupFetch(paginatedEmpty);
    renderWithProviders(
      <Routes>
        <Route path="/queries" element={<QueriesListPage />} />
      </Routes>,
      { route: "/queries" },
    );

    expect(await screen.findByText(/No queries found/i)).toBeInTheDocument();
  });

  it("filter change re-fetches with correct param in the URL", async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/auth/me")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" } }),
          text: () => Promise.resolve(""),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(paginatedEmpty),
        text: () => Promise.resolve(""),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderWithProviders(
      <Routes>
        <Route path="/queries" element={<QueriesListPage />} />
      </Routes>,
      { route: "/queries" },
    );

    // Wait for initial load
    await screen.findByText(/Queries/);

    // Type in search to trigger re-fetch
    const searchInput = screen.getByRole("textbox", { name: /Search/i });
    await userEvent.type(searchInput, "YAL");

    await waitFor(
      () => {
        const calls = fetchSpy.mock.calls.map((c) => c[0] as string);
        const queriesCalls = calls.filter((u) => u.includes("/api/queries"));
        expect(queriesCalls.some((u) => u.includes("q=YAL"))).toBe(true);
      },
      { timeout: 2000 },
    );
  });
});
