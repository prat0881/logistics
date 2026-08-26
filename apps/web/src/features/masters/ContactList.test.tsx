import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ContactDto } from "@svyft/shared";
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

/** A minimal, valid contact fixture; override only what a test cares about. */
function contact(overrides: Partial<ContactDto> = {}): ContactDto {
  return {
    id: "c0",
    name: "Test Contact",
    designation: null,
    email: "test@example.com",
    contactNo: "+971500000000",
    whatsappAvailable: false,
    wechatAvailable: false,
    botimAvailable: false,
    pocLevel: "NONE",
    status: "ACTIVE",
    ...overrides,
  };
}

let contactsFixture: ContactDto[] = [];

/**
 * Renders ContactList with a given contact list already loaded. The cache is
 * seeded directly so the row is present on the very first render, not just after
 * a fetch microtask resolves — the fetch mock still backs any later refetch.
 */
function renderList({ ownerId, contacts = [] }: { ownerId?: string; contacts?: ContactDto[] }) {
  contactsFixture = contacts;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (ownerId) qc.setQueryData(["clients", ownerId, "contacts"], contacts);
  return render(
    <QueryClientProvider client={qc}>
      <ContactList ownerPath="clients" ownerId={ownerId} />
    </QueryClientProvider>,
  );
}

/**
 * Stubs fetch so GET serves the fixture list and any mutating request (PATCH/DELETE)
 * is captured instead of actually handled. Returns the capture target — undefined
 * fields mean no mutating request has been sent yet.
 */
function captureRequest() {
  const captured: { method?: string; url?: string; body?: Record<string, unknown> } = {};
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      const method = init?.method;
      if (method && method !== "GET") {
        captured.method = method;
        captured.url = url;
        captured.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        return { status: method === "DELETE" ? 204 : 200, body: method === "DELETE" ? undefined : captured.body };
      }
      return { status: 200, body: contactsFixture };
    }),
  );
  return captured;
}

/** Stubs fetch so GET serves the fixture list and any mutating request gets this response. */
function mockResponse(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (init?.method && init.method !== "GET") return { status, body };
      return { status: 200, body: contactsFixture };
    }),
  );
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

  it("edits a contact in place and sends only the changed fields", async () => {
    const captured = captureRequest(); // the file's existing helper
    renderList({ ownerId: "c1", contacts: [contact({ id: "k1", name: "Asha Menon", pocLevel: "NONE" })] });

    await userEvent.click(screen.getByRole("button", { name: /edit asha menon/i }));
    const level = screen.getByLabelText(/poc level/i);
    await userEvent.selectOptions(level, "PRIMARY");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));

    await waitFor(() => expect(captured.method).toBe("PATCH"));
    expect(captured.url).toBe("/api/clients/c1/contacts/k1");
    expect(captured.body).toEqual({ pocLevel: "PRIMARY" });
  });

  it("surfaces the 409 when promoting a second contact, naming what to do about it", async () => {
    mockResponse(409, { message: "This client already has a primary contact" });
    renderList({ ownerId: "c1", contacts: [contact({ id: "k2", name: "Ravi Kumar", pocLevel: "NONE" })] });

    await userEvent.click(screen.getByRole("button", { name: /edit ravi kumar/i }));
    await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "PRIMARY");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already has a primary contact/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/demote/i);
  });

  it("asks before deleting, and does not call the API when cancelled", async () => {
    const captured = captureRequest();
    renderList({ ownerId: "c1", contacts: [contact({ id: "k3", name: "Mei Lin" })] });

    await userEvent.click(screen.getByRole("button", { name: /remove mei lin/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(captured.method).toBeUndefined();

    await userEvent.click(screen.getByRole("button", { name: /remove mei lin/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    await waitFor(() => expect(captured.method).toBe("DELETE"));
    expect(captured.url).toBe("/api/clients/c1/contacts/k3");
  });
});
