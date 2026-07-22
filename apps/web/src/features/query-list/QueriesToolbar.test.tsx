import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { QueriesToolbar } from "./QueriesToolbar";

afterEach(() => vi.unstubAllGlobals());

describe("QueriesToolbar — All clears the facet", () => {
  it("emits status: undefined when 'All statuses' is chosen", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "U", email: "u@x.com", role: "ADMINISTRATOR" } } };
        return { status: 200, body: {} };
      }),
    );
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup();

    // Step 1: select a specific status first so the trigger no longer shows "All statuses".
    // This avoids the jsdom/Radix issue where "All statuses" appears in both the trigger
    // and the dropdown simultaneously, causing findByText to find multiple elements.
    await user.click(screen.getByLabelText("Status filter"));
    await user.click(await screen.findByText("DRAFT"));

    // Step 2: now open the select again and choose "All statuses".
    // The trigger now shows "DRAFT", so "All statuses" is unique in the dropdown.
    await user.click(screen.getByLabelText("Status filter"));
    await user.click(await screen.findByText("All statuses"));

    const last = onChange.mock.calls.at(-1)![0];
    expect(last).toHaveProperty("status", undefined);
  });
});
