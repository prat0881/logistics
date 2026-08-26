import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContactList } from "./ContactList";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderContactList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ContactList ownerPath="clients" ownerId="c1" />
    </QueryClientProvider>,
  );
}

async function fillRequiredFields() {
  await userEvent.type(screen.getByLabelText(/name/i), "Asha Menon");
  await userEvent.type(screen.getByLabelText(/email/i), "asha@example.com");
  await userEvent.type(screen.getByLabelText(/phone/i), "+971501234567");
}

describe("ContactList", () => {
  it("shows the 'save this record first' message when there is no ownerId", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ContactList ownerPath="clients" ownerId={undefined} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/save this record before adding contacts/i)).toBeInTheDocument();
  });

  it("submits pocLevel NONE when the user never touches the POC level dropdown", async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/clients/c1/contacts") && init?.method === "POST") {
          captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return { status: 201, body: { id: "ct1", ...captured.body } };
        }
        if (url.endsWith("/api/clients/c1/contacts")) return { status: 200, body: [] };
        return { status: 404 };
      }),
    );

    renderContactList();
    await fillRequiredFields();
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body?.pocLevel).toBe("NONE");
  });

  it("surfaces a 409 conflict message instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/clients/c1/contacts") && init?.method === "POST") {
          return { status: 409, body: { message: "This client already has a primary contact" } };
        }
        if (url.endsWith("/api/clients/c1/contacts")) return { status: 200, body: [] };
        return { status: 404 };
      }),
    );

    renderContactList();
    await fillRequiredFields();
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));

    await waitFor(() =>
      expect(screen.getByText("This client already has a primary contact")).toBeInTheDocument(),
    );
    // The form was not cleared on failure — the name the user typed is still there.
    expect(screen.getByLabelText(/name/i)).toHaveValue("Asha Menon");
  });
});
