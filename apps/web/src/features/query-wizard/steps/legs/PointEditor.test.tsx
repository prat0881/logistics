import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders";
import { PointEditor } from "./PointEditor";
import type { PointSaveInput } from "@svyft/shared";

const QUERY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const POINT_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const testUser = {
  id: "u1",
  name: "Agent",
  email: "a@x",
  role: "EXECUTIVE" as const,
};

/** Helper: a point returned from the API after save */
const makePointResponse = (overrides: Partial<PointSaveInput> = {}) => ({
  id: POINT_ID,
  queryId: QUERY_ID,
  type: "AIRPORT",
  name: "Heathrow",
  iataCode: "LHR",
  city: "London",
  country: "UK",
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PointEditor", () => {
  it("renders an open dialog", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ user: testUser }),
      text: () => Promise.resolve(""),
      blob: () => Promise.resolve(new Blob()),
    } as Response)));

    const onSaved = vi.fn();
    const onClose = vi.fn();

    renderWithProviders(
      <PointEditor
        queryId={QUERY_ID}
        open
        onSaved={onSaved}
        onClose={onClose}
      />,
      { user: testUser },
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("when type=AIRPORT is selected, shows IATA field and hides street address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/auth/me"))
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ user: testUser }),
            text: () => Promise.resolve(""),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      }),
    );

    renderWithProviders(
      <PointEditor
        queryId={QUERY_ID}
        open
        type="AIRPORT"
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // IATA Code input should be visible
    await waitFor(() => {
      expect(screen.getByLabelText(/iata code/i)).toBeInTheDocument();
    });

    // Street address should NOT be visible for AIRPORT
    expect(screen.queryByLabelText(/street address/i)).not.toBeInTheDocument();
  });

  it("switching type select to SEAPORT shows UN/LOCODE and hides IATA", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/auth/me"))
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ user: testUser }),
            text: () => Promise.resolve(""),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      }),
    );

    renderWithProviders(
      <PointEditor
        queryId={QUERY_ID}
        open
        type="SEAPORT"
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/un\/locode/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/iata code/i)).not.toBeInTheDocument();
  });

  it("an invalid IATA code ('XX') shows a schema error and does NOT POST", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ user: testUser }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      return Promise.resolve({
        ok: true, status: 201,
        json: () => Promise.resolve(makePointResponse()),
        text: () => Promise.resolve(JSON.stringify(makePointResponse())),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <PointEditor
        queryId={QUERY_ID}
        open
        type="AIRPORT"
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Fill in the IATA field with an invalid value (2 chars, not 3)
    const iataInput = await screen.findByLabelText(/iata code/i);
    await user.clear(iataInput);
    await user.type(iataInput, "XX");

    // Fill required field (airport name via placeholder)
    const nameInput = screen.getByPlaceholderText(/airport name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Test Airport");

    // Submit
    const saveBtn = screen.getByRole("button", { name: /save/i });
    await user.click(saveBtn);

    // Schema error message should appear
    await waitFor(() => {
      expect(screen.getByText(/iata must be 3 uppercase letters/i)).toBeInTheDocument();
    });

    // POST should NOT have been called
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === `/api/queries/${QUERY_ID}/points` &&
        (init as RequestInit)?.method === "POST",
    );
    expect(postCall).toBeFalsy();
  });

  it("a valid AIRPORT save POSTs the correct payload and calls onSaved", async () => {
    const user = userEvent.setup();
    const pointResponse = makePointResponse({
      type: "AIRPORT",
      name: "Heathrow",
      iataCode: "LHR",
      city: "London",
      country: "UK",
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ user: testUser }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);

      if (
        url === `/api/queries/${QUERY_ID}/points` &&
        init?.method === "POST"
      )
        return Promise.resolve({
          ok: true, status: 201,
          json: () => Promise.resolve(pointResponse),
          text: () => Promise.resolve(JSON.stringify(pointResponse)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);

      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onSaved = vi.fn();

    renderWithProviders(
      <PointEditor
        queryId={QUERY_ID}
        open
        type="AIRPORT"
        onSaved={onSaved}
        onClose={vi.fn()}
      />,
    );

    // Fill the name field (use airport-specific placeholder to disambiguate from Contact Name)
    const nameInput = await screen.findByPlaceholderText(/airport name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Heathrow");

    // Fill the IATA field
    const iataInput = screen.getByLabelText(/iata code/i);
    await user.clear(iataInput);
    await user.type(iataInput, "LHR");

    // Fill city and country
    const cityInput = screen.getByLabelText(/city/i);
    await user.clear(cityInput);
    await user.type(cityInput, "London");

    const countryInput = screen.getByLabelText(/country/i);
    await user.clear(countryInput);
    await user.type(countryInput, "UK");

    // Postal Code (mandatory for AIRPORT per #4)
    const postalInput = screen.getByLabelText(/postal code/i);
    await user.clear(postalInput);
    await user.type(postalInput, "TW6 1EW");

    // Submit
    const saveBtn = screen.getByRole("button", { name: /save/i });
    await user.click(saveBtn);

    // Verify POST was called with correct payload
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/points` &&
          (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.type).toBe("AIRPORT");
      expect(body.name).toBe("Heathrow");
      expect(body.iataCode).toBe("LHR");
      expect(body.city).toBe("London");
      expect(body.country).toBe("UK");
    });

    // onSaved should have been called with the returned point
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ id: POINT_ID, type: "AIRPORT" }),
      );
    });
  });

  it("uppercases a lowercased IATA code as it is typed (G9)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(url.includes("/api/auth/me") ? { user: testUser } : {}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
      ),
    );

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open type="AIRPORT" onSaved={vi.fn()} onClose={vi.fn()} />,
    );

    const iataInput = await screen.findByLabelText(/iata code/i);
    await user.clear(iataInput);
    await user.type(iataInput, "lhr");
    expect((iataInput as HTMLInputElement).value).toBe("LHR");
  });

  it("saves a partial point without hard-blocking on missing type fields (Round-1 Common #5)", async () => {
    const user = userEvent.setup();
    const partialPointResponse = {
      id: "11111111-1111-1111-1111-111111111111",
      queryId: QUERY_ID,
      type: "AIRPORT",
      name: "Heathrow",
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ user: testUser }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      if (
        (url as string) === `/api/queries/${QUERY_ID}/points` &&
        (init as RequestInit)?.method === "POST"
      )
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(partialPointResponse),
          text: () => Promise.resolve(JSON.stringify(partialPointResponse)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open type="AIRPORT" onSaved={vi.fn()} onClose={vi.fn()} />,
    );

    // Fill only name; leave IATA, city, postal, country empty (partial draft)
    const nameInput = await screen.findByPlaceholderText(/airport name/i);
    await user.type(nameInput, "Heathrow");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // add (POST) must be called — no hard-block on partial drafts
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          (url as string) === `/api/queries/${QUERY_ID}/points` &&
          (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
    });
  });
});
