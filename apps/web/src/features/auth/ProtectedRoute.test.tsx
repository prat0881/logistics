import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./AuthProvider";
import { ProtectedRoute } from "./ProtectedRoute";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderAt(initial: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<p>login screen</p>} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <p>secret home</p>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("ProtectedRoute", () => {
  it("redirects to /login when unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ status: 401 })),
    );
    renderAt("/");
    await waitFor(() => expect(screen.getByText("login screen")).toBeInTheDocument());
  });

  it("renders children when authenticated", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        status: 200,
        body: { user: { id: "1", name: "A", email: "a@b.com", role: "EXECUTIVE" } },
      })),
    );
    renderAt("/");
    await waitFor(() => expect(screen.getByText("secret home")).toBeInTheDocument());
  });
});
