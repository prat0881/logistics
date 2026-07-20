import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "./AuthProvider";
import { fetchJson } from "@/lib/api";
import { mockFetch } from "@/test/mock-fetch";

function Probe() {
  const { user, loading } = useAuth();
  if (loading) return <p>loading</p>;
  return <p>{user ? `user:${user.email}` : "anon"}</p>;
}

function ProbePing() {
  const { user, loading } = useAuth();
  if (loading) return <p>loading</p>;
  return (
    <>
      <p>{user ? `user:${user.email}` : "anon"}</p>
      <button onClick={() => void fetchJson("/api/queries").catch(() => {})}>ping</button>
    </>
  );
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

  it("clears the user when a protected request 401s mid-session (U1)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/auth/me")
          ? { status: 200, body: { user: { id: "1", name: "A", email: "a@b.com", role: "MANAGER" } } }
          : { status: 401 },
      ),
    );
    render(
      <AuthProvider>
        <ProbePing />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("user:a@b.com")).toBeInTheDocument());
    await userEvent.click(screen.getByText("ping"));
    await waitFor(() => expect(screen.getByText("anon")).toBeInTheDocument());
  });
});
