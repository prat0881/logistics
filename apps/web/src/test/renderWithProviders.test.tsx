import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./renderWithProviders";
import { useAuth } from "@/features/auth/AuthProvider";

afterEach(() => vi.unstubAllGlobals());

function UserDisplay() {
  const { user } = useAuth();
  if (!user) return <span>no-user</span>;
  return <span data-testid="user-name">{user.name}</span>;
}

describe("renderWithProviders", () => {
  it("authenticates as the given user without a manual auth stub", async () => {
    const user = {
      id: "u1",
      name: "Alice Exec",
      email: "alice@svyft.ai",
      role: "EXECUTIVE" as const,
    };

    renderWithProviders(<UserDisplay />, { user });

    // The user name should appear once auth resolves — no manual stub needed
    await waitFor(() => {
      expect(screen.getByTestId("user-name")).toHaveTextContent("Alice Exec");
    });
  });

  it("renders without user option without stubbing fetch (shows no-user)", async () => {
    // Stub fetch to avoid real network hit; no user provided
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      }),
    );

    renderWithProviders(<UserDisplay />);

    await waitFor(() => {
      expect(screen.getByText("no-user")).toBeInTheDocument();
    });
  });
});
