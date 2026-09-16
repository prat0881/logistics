import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ClientFormPage } from "./ClientFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const authMe = { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
// WarehousePicker now queries the unassigned pool unconditionally (Task 8 dropped the ownerId
// gate, since a brand-new record can assign warehouses before it exists) — every test renders
// through it, so every handler below needs a branch for it.
const emptyUnassignedWarehouses = { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };

function renderAtRoute(
  initialEntry: string,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/masters/clients/new" element={<ClientFormPage />} />
            <Route path="/masters/clients/:id" element={<ClientFormPage />} />
            <Route path="/masters/clients" element={<p>clients list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function fillParentFields(companyName: string) {
  await userEvent.type(await screen.findByLabelText(/company name/i), companyName);
  await userEvent.type(screen.getByLabelText(/country/i), "IN");
  await userEvent.type(screen.getByLabelText(/street address/i), "1 Test Road");
  await userEvent.type(screen.getByLabelText(/city/i), "Test City");
}

async function addContactViaDialog({
  name,
  email,
  phone,
  primary,
}: {
  name: string;
  email: string;
  phone: string;
  primary: boolean;
}) {
  await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
  await userEvent.type(screen.getByLabelText(/^name$/i), name);
  await userEvent.type(screen.getByLabelText(/email/i), email);
  await userEvent.type(screen.getByLabelText(/phone/i), phone);
  if (primary) await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "PRIMARY");
  await userEvent.click(screen.getByRole("button", { name: /save contact/i }));
}

describe("ClientFormPage (create)", () => {
  it("sends parent fields, contacts and warehouses in ONE request", async () => {
    // Capture every mutating (non-GET) call, not just the ones matching the expected URL/method
    // — a stray write (e.g. a leftover PUT to /api/clients/:id/warehouses) would 404 in this
    // mock and vanish silently if only the POST branch pushed into the array, letting a
    // regression through a test literally named "ONE request".
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) {
          return {
            status: 200,
            body: { items: [{ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "Depot One" }], total: 1, page: 1, pageSize: 100 },
          };
        }
        if (init?.method && init.method !== "GET") {
          calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
          if (url.endsWith("/api/clients") && init.method === "POST") {
            return {
              status: 201,
              body: { id: "c9", clientCode: "CL-0009", companyName: "NewCo", country: "IN", status: "ACTIVE" },
            };
          }
          return { status: 404 };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/new");
    await fillParentFields("NewCo");
    await addContactViaDialog({ name: "Asha Menon", email: "asha@example.com", phone: "+971501234567", primary: true });
    await userEvent.click(await screen.findByRole("checkbox", { name: "Depot One" }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/api/clients");
    expect(calls[0].body).toMatchObject({
      companyName: "NewCo",
      contacts: [expect.objectContaining({ name: "Asha Menon", pocLevel: "PRIMARY" })],
      warehouseIds: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
    });
  });

  it("blocks Save when no contact is marked Primary", async () => {
    const postCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/clients") && init?.method === "POST") {
          postCalls.push(1);
          return { status: 201, body: {} };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/new");
    await fillParentFields("NewCo");
    await addContactViaDialog({ name: "No Primary Person", email: "np@example.com", phone: "+971501112222", primary: false });
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/one contact must be marked primary/i);
    expect(postCalls).toHaveLength(0);
  });

  it("renders the Status field the schema has always carried", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/new");
    expect(await screen.findByLabelText(/status/i)).toBeInTheDocument();
  });
});

describe("ClientFormPage save failure", () => {
  // Mirrors ChargeLineFormPage: before this, onSubmit had no try/catch and there is no toast
  // system anywhere in apps/web, so a rejected save produced NOTHING — the button stopped
  // spinning and the page sat there. The 409 below is the message the API actually returns.
  // A primary contact must be added first: create-mode now blocks the network call entirely
  // when no contact is marked Primary, so reaching the server's 409 requires a valid draft.
  it("surfaces the server's error message instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/clients") && init?.method === "POST")
          return { status: 409, body: { message: "A client with that company name already exists" } };
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/new");
    await fillParentFields("Dupe Co");
    await addContactViaDialog({ name: "Asha Menon", email: "asha@example.com", phone: "+971501234567", primary: true });
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    // Still on the form: a refused save must never look like a successful one.
    expect(screen.queryByText("clients list")).not.toBeInTheDocument();
  });

  // ZodValidationPipe throws `{ message: "Validation failed", issues }` for every schema
  // rejection, so a naive `err.message` read would render that constant instead of the actual
  // rule text. The masters' `masterErrorMessage` helper (apps/web/src/features/masters/form)
  // reads the first usable `issues[]` message instead — this is the end-to-end proof that the
  // wiring through ClientFormPage's onSubmit actually surfaces it.
  it("surfaces the issue's own message instead of the ZodValidationPipe constant", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/clients") && init?.method === "POST")
          return {
            status: 400,
            body: {
              message: "Validation failed",
              issues: [{ message: "Exactly one contact must be marked Primary" }],
            },
          };
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/new");
    await fillParentFields("NewCo");
    await addContactViaDialog({ name: "Asha Menon", email: "asha@example.com", phone: "+971501234567", primary: true });
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/exactly one contact must be marked primary/i)).toBeInTheDocument();
    expect(screen.queryByText("Validation failed")).not.toBeInTheDocument();
  });
});

describe("ClientFormPage (edit)", () => {
  function mockLegacyClient({
    id,
    pocLevel,
    patchCalls,
    assignedWarehouses = [],
    warehousesFail = false,
  }: {
    id: string;
    pocLevel: "NONE" | "PRIMARY";
    patchCalls: unknown[];
    assignedWarehouses?: { id: string; name: string }[];
    warehousesFail?: boolean;
  }) {
    return mockFetch((url, init) => {
      if (url.endsWith("/api/auth/me")) return authMe;
      if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
      if (url.endsWith(`/api/clients/${id}/warehouses`))
        return warehousesFail
          ? { status: 500, body: { message: "warehouses unavailable" } }
          : { status: 200, body: assignedWarehouses };
      if (url.endsWith(`/api/clients/${id}`)) {
        if (init?.method === "PATCH") {
          patchCalls.push(JSON.parse(String(init.body)));
          return { status: 200, body: {} };
        }
        return {
          status: 200,
          body: {
            id,
            clientCode: "CL-0001",
            companyName: "Legacy Co",
            industry: null,
            country: "IN",
            streetAddress: "1 Old Rd",
            city: "Old City",
            postalCode: null,
            status: "ACTIVE",
            contacts: [
              {
                id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
                name: "Asha Menon",
                designation: null,
                email: "asha@example.com",
                contactNo: "+971501234567",
                whatsappAvailable: false,
                wechatAvailable: false,
                botimAvailable: false,
                pocLevel,
                status: "ACTIVE",
              },
            ],
          },
        };
      }
      return { status: 404 };
    });
  }

  it("shows the advisory banner on a loaded client with no primary, and still saves — carrying contacts and an emptied warehouseIds", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockLegacyClient({
        id: "c1",
        pocLevel: "NONE",
        patchCalls,
        assignedWarehouses: [{ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "Depot One" }],
      }),
    );
    renderAtRoute("/masters/clients/c1");

    expect(await screen.findByRole("status")).toHaveTextContent(/no primary contact/i);
    // Unchecking the loaded warehouse is what proves warehouseIds actually reaches the wire as
    // an explicit `[]`, not merely absent — the API reads "absent" as "unset" for optional
    // fields on PATCH, but reads an explicit empty array as "unassign everything". The old
    // WarehousePicker-only test for this ("unassigning everything sends an empty array") no
    // longer applies to that component (it doesn't touch the network anymore) — this is where
    // that guarantee now has to be proven, at the boundary where it actually matters.
    await userEvent.click(await screen.findByRole("checkbox", { name: "Depot One" }));
    // Save without touching any other field — an unrelated field edit isn't even needed to
    // expose the contacts hazard: if the load effect failed to map `contacts` in, this PATCH
    // would carry an empty array and the API (which treats "absent from the array" as "delete")
    // would wipe the client's one legacy contact on the very first save.
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0]).toMatchObject({
      contacts: [expect.objectContaining({ name: "Asha Menon", pocLevel: "NONE" })],
      warehouseIds: [],
    });
  });

  // The third state of the §4.4 rule, and the one the two tests above don't cover: the record
  // LOADED with a primary and the user is demoting it away. That must block, even though a
  // record that loaded WITHOUT one saves freely.
  it("blocks Save when the user demotes away the primary the record loaded with", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal("fetch", mockLegacyClient({ id: "c2", pocLevel: "PRIMARY", patchCalls }));
    renderAtRoute("/masters/clients/c2");

    await userEvent.click(await screen.findByRole("button", { name: /asha menon/i }));
    await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "SECONDARY");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/one contact must be marked primary/i);
    expect(patchCalls).toHaveLength(0);
  });

  // The third data-loss path, the same mechanism as the FF contacts gate one query over.
  // `warehouseIds` is seeded `[]` by defaultValues and only filled in by the load effect's
  // `(ownedWarehouses.data ?? []).map(...)`. When GET /:id/warehouses fails, `data` stays
  // undefined permanently (react-query has already exhausted its retries, and
  // WarehousePicker's seeding effect is guarded on a truthy `assignedSignature` so it never
  // fires either) while GET /:id has resolved and the form is fully valid and Save-able.
  // `warehouseIds` is a declared schema field, so the explicit `[]` survives the resolver and
  // reaches the wire; server-side `if (warehouseIds)` passes (`Boolean([])` is `true`) and
  // setWarehousesTx's `updateMany({ where: { clientId, id: { notIn: [] } } })` matches EVERY
  // row — detaching every warehouse this client owns.
  it("blocks Save (sends no PATCH) when the assigned-warehouses fetch has failed", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockLegacyClient({ id: "c4", pocLevel: "PRIMARY", patchCalls, warehousesFail: true }),
    );
    renderAtRoute("/masters/clients/c4");

    // The parent record is fully loaded and valid, and it has a primary contact — neither the
    // record nor the three-state primary rule blocks Save. Only the failed warehouses fetch
    // should.
    await screen.findByLabelText(/company name/i);
    await waitFor(() => expect(screen.getByLabelText(/company name/i)).toHaveValue("Legacy Co"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => /warehouses/i.test(a.textContent ?? ""))).toBe(true);
    expect(patchCalls).toHaveLength(0);
  });

  // The counterpart to the test above: the warehouses gate must block a draft that never got
  // its ids, and ONLY that draft. Here the query loaded cleanly and a later background refetch
  // failed, so the state is "error" while `data` still holds the ids the load effect already
  // seeded — the data-loss path the gate exists for is not live, and Save must go through.
  //
  // The keystroke before the click is load-bearing, not incidental typing. React-query derives
  // the observer's `isSuccess` straight from that "error" state, but `notifyOnChangeProps`
  // tracking means the failed refetch notifies nobody while only `data` is read during render,
  // so without a re-render the component keeps serving the pre-failure result and the old
  // `!isSuccess` gate would pass by luck. Typing forces the render that exposes the real
  // values, which is exactly how a user meets this: edit a field, hit Save, get told to retry
  // when nothing is wrong. Asserting the query state below keeps the fixture's claim checkable.
  it("still saves when the assigned-warehouses query succeeded and only a later refetch failed", async () => {
    const patchCalls: { warehouseIds?: string[] }[] = [];
    let warehouseCalls = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/clients/c9/warehouses")) {
          warehouseCalls += 1;
          // First read succeeds; every later one fails — exactly a healthy load followed by a
          // broken background refetch.
          return warehouseCalls === 1
            ? { status: 200, body: [{ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "WH One" }] }
            : { status: 500, body: { message: "warehouses unavailable" } };
        }
        if (url.endsWith("/api/clients/c9")) {
          if (init?.method === "PATCH") {
            patchCalls.push(JSON.parse(String(init.body)));
            return { status: 200, body: {} };
          }
          return {
            status: 200,
            body: {
              id: "c9",
              clientCode: "CL-0009",
              companyName: "Refetch Co",
              industry: null,
              country: "IN",
              streetAddress: "1 Old Rd",
              city: "Old City",
              postalCode: null,
              status: "ACTIVE",
              contacts: [
                {
                  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
                  name: "Asha Menon",
                  designation: null,
                  email: "asha@example.com",
                  contactNo: "+971501234567",
                  whatsappAvailable: false,
                  wechatAvailable: false,
                  botimAvailable: false,
                  pocLevel: "PRIMARY",
                  status: "ACTIVE",
                },
              ],
            },
          };
        }
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderAtRoute("/masters/clients/c9", qc);

    await waitFor(() => expect(screen.getByLabelText(/company name/i)).toHaveValue("Refetch Co"));
    await waitFor(() => expect(qc.getQueryData(["clients", "c9", "warehouses"])).toBeDefined());

    await qc.refetchQueries({ queryKey: ["clients", "c9", "warehouses"] });

    // Prove the fixture actually produced the state under test before asserting on behaviour —
    // otherwise a refetch that silently never happened would let this pass for the wrong reason.
    const state = qc.getQueryState(["clients", "c9", "warehouses"]);
    expect(state?.status).toBe("error");
    expect(state?.data).toBeDefined();

    // Forces the re-render that surfaces the post-failure observer result — see above.
    await userEvent.type(screen.getByLabelText(/company name/i), "x");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].warehouseIds).toEqual(["7c9e6679-7425-40de-944b-e07fc1f90ae7"]);
  });

  // The `id` on a dialog-edited contact survives only because react-hook-form carries
  // unregistered `defaultValues` through `handleSubmit` and `contactUpsertSchema` declares
  // `id` — two non-obvious mechanisms, neither pinned anywhere. If either changed, every
  // dialog edit would silently become delete-plus-create: new row ids, lost audit rows, and
  // reconcileContacts deleting the original because it is absent from the payload. The three
  // dialog tests on the form pages are all *add* flows, which cannot catch that.
  it("carries the loaded contact's id through a dialog edit and into the PATCH body", async () => {
    const patchCalls: { contacts?: { id?: string; name?: string }[] }[] = [];
    vi.stubGlobal("fetch", mockLegacyClient({ id: "c5", pocLevel: "PRIMARY", patchCalls }));
    renderAtRoute("/masters/clients/c5");

    await userEvent.click(await screen.findByRole("button", { name: /asha menon/i }));
    await userEvent.clear(screen.getByLabelText(/^name$/i));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Asha M. Menon");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].contacts).toMatchObject([
      { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", name: "Asha M. Menon" },
    ]);
  });

  // Nothing in this page renders `errors.contacts` — ContactsSection is Controller-driven, not
  // a Field. Before the onInvalid handler existed, a loaded contact that failed validation (the
  // realistic case: a ClientContact row predating the tightened E.164 phone rule) made
  // zodResolver reject the whole submit, RHF never called the submit handler at all, and Save
  // just... stopped spinning. Silently. On exactly the legacy record whose only repair surface
  // is this screen. This is the same "rejected save produced nothing" failure the try/catch
  // exists to prevent, reached through a path the try/catch can't cover because it's never
  // entered.
  it("surfaces a visible error when a loaded contact fails validation, instead of doing nothing", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/clients/c3/warehouses")) return { status: 200, body: [] };
        if (url.endsWith("/api/clients/c3")) {
          if (init?.method === "PATCH") {
            patchCalls.push(1);
            return { status: 200, body: {} };
          }
          return {
            status: 200,
            body: {
              id: "c3",
              clientCode: "CL-0003",
              companyName: "Bad Phone Co",
              industry: null,
              country: "IN",
              streetAddress: "3 Old Rd",
              city: "Old City",
              postalCode: null,
              status: "ACTIVE",
              contacts: [
                {
                  id: "9e0c4c1a-2a3b-4d5e-8f6a-1b2c3d4e5f60",
                  name: "Legacy Contact",
                  designation: null,
                  email: "legacy@example.com",
                  // Missing the leading "+" — predates the E.164 tightening, fails
                  // contactUpsertSchema's regex on load.
                  contactNo: "971501234567",
                  whatsappAvailable: false,
                  wechatAvailable: false,
                  botimAvailable: false,
                  pocLevel: "PRIMARY",
                  status: "ACTIVE",
                },
              ],
            },
          };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/c3");

    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/legacy contact/i);
    expect(patchCalls).toHaveLength(0);
  });

  it("arms the discard guard when only a contact was changed", async () => {
    // Loads a client, edits nothing but a contact through the dialog, then cancels.
    // `contacts` is Controller-managed, so this is what proves react-hook-form marks the form
    // dirty for controlled fields — without that, the guard silently never fires on the one
    // kind of edit these screens exist for.
    vi.stubGlobal("fetch", mockLegacyClient({ id: "c1", pocLevel: "PRIMARY", patchCalls: [] }));
    renderAtRoute("/masters/clients/c1");
    await userEvent.click(await screen.findByRole("button", { name: /edit asha menon/i }));
    const nameField = await screen.findByLabelText(/^name$/i);
    await userEvent.clear(nameField);
    await userEvent.type(nameField, "Asha Menon-Rao");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/discard unsaved changes/i)).toBeInTheDocument();
  });

  // `queryClient` is constructed bare in lib/api.ts, so refetchOnWindowFocus is on with
  // staleTime 0: tabbing away to copy an address and back refetches this record mid-edit. The
  // hydration effect keys on `existing.data`, and its reset() replaces the WHOLE draft — every
  // typed field plus the Controller-managed contacts and warehouse arrays.
  //
  // **The refetch must return CHANGED data for this to bite, and that is not a detail of the
  // test — it is the shape of the bug.** react-query applies structural sharing
  // (`replaceEqualDeep`), so a refetch whose body is deeply equal to the cached one keeps the
  // PREVIOUS object reference; `existing.data`'s identity never changes and the effect never
  // re-runs. An earlier version of this test refetched identical data and passed with the guard
  // deliberately disabled — it could not fail. So the reachable hazard is specifically: someone
  // else edits the record (or any field of it changes server-side) while this user has the form
  // open, and their in-progress work is replaced by the other person's version without warning.
  //
  // invalidateQueries drives the refetch rather than a synthetic focus event: it exercises the
  // same path (refetch on a query that already holds data) without depending on jsdom focus
  // handling or on react-query's focus manager being wired up under test.
  it("does not discard a started edit when a background refetch brings changed data", async () => {
    let clientGets = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/clients/c1/warehouses")) return { status: 200, body: [] };
        if (url.endsWith("/api/clients/c1")) {
          clientGets += 1;
          return {
            status: 200,
            body: {
              id: "c1",
              clientCode: "CL-0001",
              // Changes on the second GET, standing in for a concurrent edit by someone else.
              companyName: clientGets === 1 ? "Legacy Co" : "Legacy Co (edited elsewhere)",
              industry: null,
              country: "IN",
              streetAddress: "1 Old Rd",
              city: "Old City",
              postalCode: null,
              status: "ACTIVE",
              contacts: [
                {
                  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
                  name: "Asha Menon",
                  designation: null,
                  email: "asha@example.com",
                  contactNo: "+971501234567",
                  whatsappAvailable: false,
                  wechatAvailable: false,
                  botimAvailable: false,
                  pocLevel: "PRIMARY",
                  status: "ACTIVE",
                },
              ],
            },
          };
        }
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderAtRoute("/masters/clients/c1", qc);

    const companyName = await screen.findByLabelText(/company name/i);
    await waitFor(() => expect(companyName).toHaveValue("Legacy Co"));
    await userEvent.clear(companyName);
    await userEvent.type(companyName, "Renamed Mid-Edit Co");

    await qc.invalidateQueries();
    // Assert only once the refetch has settled, so this cannot pass by outrunning the very
    // refetch it exists to survive.
    await waitFor(() => expect(clientGets).toBeGreaterThan(1));
    await waitFor(() => expect(qc.isFetching()).toBe(0));

    expect(companyName).toHaveValue("Renamed Mid-Edit Co");
    // The contact must survive too: reset() replaces the whole Controller-managed array, and
    // losing a contact is worse than losing a typed field.
    expect(screen.getByRole("button", { name: /edit asha menon/i })).toBeInTheDocument();
  });
});
