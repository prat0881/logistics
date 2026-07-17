import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./AuthProvider";
import { LoginPage } from "./LoginPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderLogin() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>home for a@b.com</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("LoginPage", () => {
  it("logs in and navigates home on success", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me")) return { status: 401 };
        if (url.endsWith("/api/auth/login"))
          return {
            status: 200,
            body: { user: { id: "1", name: "A", email: "a@b.com", role: "EXECUTIVE" } },
          };
        return { status: 404 };
      }),
    );
    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "a@b.com");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByText("home for a@b.com")).toBeInTheDocument());
  });

  it("shows an error on invalid credentials", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => (url.endsWith("/api/auth/login") ? { status: 401 } : { status: 401 })),
    );
    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "a@b.com");
    await userEvent.type(screen.getByLabelText("Password"), "bad");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password."),
    );
  });
});
