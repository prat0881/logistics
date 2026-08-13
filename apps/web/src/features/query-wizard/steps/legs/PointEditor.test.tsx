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
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ user: testUser }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
      ),
    );

    const onSaved = vi.fn();
    const onClose = vi.fn();

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open onSaved={onSaved} onClose={onClose} />,
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
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user: testUser }),
            text: () => Promise.resolve(""),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      }),
    );

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open type="AIRPORT" onSaved={vi.fn()} onClose={vi.fn()} />,
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
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user: testUser }),
            text: () => Promise.resolve(""),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      }),
    );

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open type="SEAPORT" onSaved={vi.fn()} onClose={vi.fn()} />,
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
          ok: true,
          status: 200,
          json: () => Promise.resolve({ user: testUser }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve(makePointResponse()),
        text: () => Promise.resolve(JSON.stringify(makePointResponse())),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open type="AIRPORT" onSaved={vi.fn()} onClose={vi.fn()} />,
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
        url === `/api/queries/${QUERY_ID}/points` && (init as RequestInit)?.method === "POST",
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
          ok: true,
          status: 200,
          json: () => Promise.resolve({ user: testUser }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);

      if (url === `/api/queries/${QUERY_ID}/points` && init?.method === "POST")
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(pointResponse),
          text: () => Promise.resolve(JSON.stringify(pointResponse)),
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

    const onSaved = vi.fn();

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open type="AIRPORT" onSaved={onSaved} onClose={vi.fn()} />,
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

    // Country is a CountryCombobox — open it, search by name, select the option.
    // Selecting "United Kingdom" emits its ISO code ("GB"), not the raw name.
    await user.click(screen.getByRole("button", { name: /^country$/i }));
    await user.type(screen.getByPlaceholderText(/search country/i), "United Kingdom");
    await user.click(await screen.findByRole("option", { name: "United Kingdom" }));

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
          url === `/api/queries/${QUERY_ID}/points` && (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.type).toBe("AIRPORT");
      expect(body.name).toBe("Heathrow");
      expect(body.iataCode).toBe("LHR");
      expect(body.city).toBe("London");
      expect(body.country).toBe("GB");
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

  it("edit mode shows a Delete button that removes the point after confirm", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const EDIT_POINT_ID = "edit-point-1111-1111-1111-111111111111";
    const editPoint = {
      id: EDIT_POINT_ID,
      type: "PICKUP" as const,
      name: "Edit Me",
      streetAddress: "1 Test St",
      city: "London",
      postalCode: "SW1A",
      country: "UK",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
    };

    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ user: testUser }),
          text: () => Promise.resolve(""),
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

    const onSaved = vi.fn();
    const onClose = vi.fn();

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open point={editPoint} onSaved={onSaved} onClose={onClose} />,
      { user: testUser },
    );

    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/points/${EDIT_POINT_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it("add mode shows no Delete button", () => {
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
      <PointEditor queryId={QUERY_ID} open onSaved={vi.fn()} onClose={vi.fn()} />,
      { user: testUser },
    );

    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("blocks deleting a point referenced by a leg (no DELETE) and shows a message", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const REF_POINT_ID = "aaaa1111-aaaa-1111-aaaa-1111aaaa1111";
    const refPoint = {
      id: REF_POINT_ID,
      type: "PICKUP" as const,
      name: "Used Point",
      streetAddress: "1 Test St",
      city: "London",
      postalCode: "SW1A",
      country: "UK",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
      timezone: null,
    };
    // A leg whose origin is this point.
    const legs = [
      {
        id: "bbbb2222-bbbb-2222-bbbb-2222bbbb2222",
        tenantId: null,
        queryId: QUERY_ID,
        legCode: "L1",
        legName: null,
        originPointId: REF_POINT_ID,
        destinationPointId: null,
        mode: null,
        readyDate: null,
        targetDelivery: null,
        status: "DRAFT" as const,
        executionStatus: "PENDING" as const,
        createdAt: "2026-01-01T00:00:00+00:00",
        updatedAt: "2026-01-01T00:00:00+00:00",
        assignedPackageIds: [],
        rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
        warehouseHandlingIncluded: null,
        chargeLineDefinitionIds: [],
      },
    ];

    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(url.includes("/api/auth/me") ? { user: testUser } : {}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <PointEditor
        queryId={QUERY_ID}
        open
        point={refPoint}
        legs={legs}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
      { user: testUser },
    );

    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    // A clear message naming the leg appears; no confirm, no DELETE.
    expect(await screen.findByText(/used by leg L1/i)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === "DELETE",
    );
    expect(deleteCall).toBeFalsy();
  });

  it("deletes an unreferenced point (legs present but none reference it)", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const FREE_POINT_ID = "cccc3333-cccc-3333-cccc-3333cccc3333";
    const freePoint = {
      id: FREE_POINT_ID,
      type: "WAREHOUSE" as const,
      name: "Unused WH",
      streetAddress: "9 Free St",
      city: "Leeds",
      postalCode: "LS1",
      country: "UK",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
      timezone: null,
    };
    // A leg that references OTHER points, not freePoint.
    const legs = [
      {
        id: "dddd4444-dddd-4444-dddd-4444dddd4444",
        tenantId: null,
        queryId: QUERY_ID,
        legCode: "L1",
        legName: null,
        originPointId: "eeee5555-eeee-5555-eeee-5555eeee5555",
        destinationPointId: "ffff6666-ffff-6666-ffff-6666ffff6666",
        mode: "ROAD" as const,
        readyDate: null,
        targetDelivery: null,
        status: "DRAFT" as const,
        executionStatus: "PENDING" as const,
        createdAt: "2026-01-01T00:00:00+00:00",
        updatedAt: "2026-01-01T00:00:00+00:00",
        assignedPackageIds: [],
        rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
        warehouseHandlingIncluded: null,
        chargeLineDefinitionIds: [],
      },
    ];

    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(url.includes("/api/auth/me") ? { user: testUser } : {}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <PointEditor
        queryId={QUERY_ID}
        open
        point={freePoint}
        legs={legs}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
      { user: testUser },
    );

    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/points/${FREE_POINT_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  describe("timezone field (Task 8 — TimezoneCombobox)", () => {
    const makeFetch = (orgZone = "Asia/Kolkata") =>
      vi.fn((url: string, _init?: RequestInit) => {
        if (url.includes("/api/auth/me"))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user: testUser }),
            text: () => Promise.resolve(""),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        if (url.includes("/api/config/org-timezone"))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ timezone: orgZone }),
            text: () => Promise.resolve(JSON.stringify({ timezone: orgZone })),
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

    it("(a) new point defaults timezone to org zone — combobox trigger shows zone + offset", async () => {
      // Use Asia/Singapore — guaranteed to be in Intl.supportedValuesOf("timeZone").
      vi.stubGlobal("fetch", makeFetch("Asia/Singapore"));

      renderWithProviders(
        <PointEditor queryId={QUERY_ID} open type="PICKUP" onSaved={vi.fn()} onClose={vi.fn()} />,
        { user: testUser },
      );

      // After org-timezone loads, the seeding useEffect fires and the TimezoneCombobox
      // trigger button text becomes "Asia/Singapore (GMT+08:00)".
      await waitFor(() => {
        expect(screen.getByText(/^Timezone$/)).toBeInTheDocument();
        // The combobox trigger button contains the zone name and its offset.
        const btn = screen.getByRole("button", { name: /point timezone/i });
        expect(btn.textContent).toMatch(/Asia\/Singapore/);
        expect(btn.textContent).toMatch(/GMT\+08:00/);
      });
    });

    it("(b) edit mode shows the point's own timezone in the combobox trigger", async () => {
      vi.stubGlobal("fetch", makeFetch("Asia/Singapore"));

      const editPoint = {
        id: POINT_ID,
        type: "DELIVERY" as const,
        name: "My Warehouse",
        streetAddress: "1 Test St",
        city: "New York",
        postalCode: "10001",
        country: "US",
        contactName: null,
        contactPhone: null,
        contactEmail: null,
        warehouseType: null,
        iataCode: null,
        icaoCode: null,
        unLocode: null,
        terminal: null,
        timezone: "America/New_York",
      };

      renderWithProviders(
        <PointEditor
          queryId={QUERY_ID}
          open
          point={editPoint}
          onSaved={vi.fn()}
          onClose={vi.fn()}
        />,
        { user: testUser },
      );

      // The combobox trigger shows the stored zone from the point, not the org zone.
      await waitFor(() => {
        expect(screen.getByText(/^Timezone$/)).toBeInTheDocument();
        const btn = screen.getByRole("button", { name: /point timezone/i });
        expect(btn.textContent).toMatch(/America\/New_York/);
      });
    });

    it("(c) timezone field label renders with a required marker (*)", async () => {
      vi.stubGlobal("fetch", makeFetch("Asia/Singapore"));

      renderWithProviders(
        <PointEditor queryId={QUERY_ID} open type="PICKUP" onSaved={vi.fn()} onClose={vi.fn()} />,
        { user: testUser },
      );

      await waitFor(() => {
        // The label text "Timezone" must exist
        expect(screen.getByText(/^Timezone$/i)).toBeInTheDocument();
        // The required marker " *" must be a sibling span within the label
        const label = screen.getByText(/^Timezone$/i).closest("label");
        expect(label).not.toBeNull();
        expect(label!.textContent).toContain("*");
      });
    });

    it("(d) org timezone Asia/Kolkata is shown in the combobox trigger (TimezoneCombobox handles alias)", async () => {
      // TimezoneCombobox prepends unknown zones to the list, so Asia/Kolkata is
      // always a valid selection even if Intl.supportedValuesOf only knows Asia/Calcutta.
      vi.stubGlobal("fetch", makeFetch("Asia/Kolkata"));

      renderWithProviders(
        <PointEditor queryId={QUERY_ID} open type="PICKUP" onSaved={vi.fn()} onClose={vi.fn()} />,
        { user: testUser },
      );

      // After org-timezone resolves, the seeding useEffect sets the form value to "Asia/Kolkata".
      // TimezoneCombobox prepends the value to its zone list so the trigger shows it.
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /point timezone/i });
        expect(btn.textContent).toMatch(/Asia\/Kolkata/);
      });
    });
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
