import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthProvider";
import { mockFetch } from "@/test/mock-fetch";

function Probe() {
  const { user, loading } = useAuth();
  if (loading) return <p>loading</p>;
  return <p>{user ? `user:${user.email}` : "anon"}</p>;
}

afterEach(() => vi.unstubAllGlobals());

describe("AuthProvider", () => {
  it("hydrates the user from /api/auth/me", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        status: 200,
        body: { user: { id: "1", name: "A", email: "a@b.com", role: "MANAGER" } },
      })),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("user:a@b.com")).toBeInTheDocument());
  });

  it("stays anonymous when /api/auth/me is 401", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ status: 401 })),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("anon")).toBeInTheDocument());
  });
});
