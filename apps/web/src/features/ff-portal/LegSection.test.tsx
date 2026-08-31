import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { LegSection } from "./LegSection";
import type { FfPortalLegDto, FfPortalRfqDto } from "@svyft/shared";

afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
};

const rfq = {
  rfqNumber: "R-1",
  incoterms: "FOB",
  submissionDeadline: "2999-01-01T00:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2999-02-01T00:00:00.000Z",
  freightForwarder: { companyName: "Acme" },
  legs: [],
} as FfPortalRfqDto;

// AIR leg with one unpriced preset charge (amount: null) — will fail Q3/charges validation
const leg = {
  legId: "L1",
  quoteId: "Q1",
  status: "RFQ_SENT",
  mode: "AIR",
  manifest: {
    cargo: [
      {
        packageId: "pk1",
        packageNo: "PK-1",
        packageType: "BOX",
        packageCount: 1,
        dimL: "100",
        dimW: "100",
        dimH: "100",
        netWt: null,
        grossWt: "1000",
        volumeCbm: "1",
        tags: [],
      },
    ],
  },
  endpoints: [],
  seededCharges: [
    {
      zone: "MAIN_FREIGHT",
      presetKey: "AIR_MAIN_FREIGHT",
      label: "Air Freight",
      isPreset: true,
      amount: null,
    },
  ],
  draft: null,
} as unknown as FfPortalLegDto;

const quotedLeg = {
  ...leg,
  status: "QUOTED",
} as unknown as FfPortalLegDto;

const requotedLeg = {
  ...leg,
  status: "REQUOTED",
} as unknown as FfPortalLegDto;

// A retained draft (ff-portal.service.ts's requote path keeps the FF's prior submission, so the
// portal must show it back rather than a blank form — QuoteDraft-shaped, chargedWeightKg is the
// simplest unconditionally-rendered numeric field (CargoWeightTable) to assert on).
const draftWithPrices = {
  legId: "L1",
  mode: "AIR",
  currency: null,
  quoteValidityUntil: null,
  chargedWeightKg: 1250,
  notes: null,
  cargo: [{ packageId: "pk1", grossWtKg: 1000, cbm: 1 }],
  charges: [],
  trucking: [],
  seaRates: [],
  warehouse: [],
  transit: null,
  dgSurchargeNote: null,
  termsConditions: null,
} as unknown as FfPortalLegDto["draft"];

const requotedLegWithDraft = {
  ...leg,
  status: "REQUOTED",
  draft: draftWithPrices,
} as unknown as FfPortalLegDto;

// Same leg, but with a warehouse endpoint + the frozen warehouseIncluded decision (design §9) —
// seedQuoteDraftWarehouse (draftFromDto's fresh-draft path) only produces a non-empty
// draft.warehouse for this fixture, not the base `leg` above (LegSection §6C finding #7).
const legWithWarehouse = {
  ...leg,
  warehouseIncluded: true,
  endpoints: [
    {
      pointId: "p1",
      type: "WAREHOUSE",
      name: "OAP Warehouse",
      country: "IN",
      code: "OAP",
      warehousePosition: "ORIGIN",
    },
  ],
} as unknown as FfPortalLegDto;

describe("LegSection submit gate", () => {
  it("blocks submit on client findings and does not POST", async () => {
    const fx = mockFetch(() => ({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fx);
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument(); // findings shown (charges unpriced etc.)
    expect(fx).not.toHaveBeenCalled(); // client gate: zero network calls on invalid submit
  });
});

describe("LegSection QUOTED branch", () => {
  it("renders AlreadySubmittedSummary for QUOTED leg and hides Submit button", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={quotedLeg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.getByText(/quote submitted/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit quote/i })).not.toBeInTheDocument();
  });
});

describe("LegSection REQUOTED branch (the negotiate feature's dead end, S5.9 §1)", () => {
  it("lets the forwarder revise a price on a REQUOTED leg", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={requotedLeg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.queryByText(/not open for quoting/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeEnabled();
  });

  it("shows the forwarder their retained draft rather than a blank form", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={requotedLegWithDraft}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.getByDisplayValue("1250")).toBeInTheDocument();
  });
});

describe("LegSection outcome-status neutrality (design D9)", () => {
  it("never tells the forwarder a commercial outcome", () => {
    for (const status of ["PENDING_APPROVAL", "APPROVED"] as const) {
      const statusLeg = { ...leg, status } as unknown as FfPortalLegDto;
      const { unmount } = render(
        wrap(
          <LegSection
            token="tok"
            rfq={rfq}
            leg={statusLeg}
            currency="USD"
            quoteValidityUntil={rfq.quoteValidityUntil}
            readOnly={false}
            open={true}
            onOpen={() => {}}
          />,
        ),
      );
      expect(screen.getByText("Under review")).toBeInTheDocument();
      expect(screen.queryByText(/approved/i)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("LegSection leg-closed branch (S5.9.5 D5)", () => {
  // The server's LEG_APPROVED_REASON verbatim (ff-portal.service.ts) — the DTO carries the copy,
  // the client only renders it, so this fixture is the contract that string travels through.
  const CLOSED = "This leg is no longer open for quoting — a forwarder has been selected.";

  const renderLeg = (l: FfPortalLegDto) =>
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={l}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );

  it("shows the reason and no quote form, even though this forwarder's own quote is still open", () => {
    // The whole point of the leg-level rule: status is RFQ_SENT — nothing about THIS forwarder's
    // quote closes it — and the leg is closed anyway.
    renderLeg({ ...leg, status: "RFQ_SENT", closedReason: CLOSED } as unknown as FfPortalLegDto);
    expect(screen.getByText(CLOSED)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save draft/i })).not.toBeInTheDocument();
    // Vocabulary rule D5, on a forwarder-facing surface: never "awarded", and never a name.
    expect(screen.queryByText(/award/i)).not.toBeInTheDocument();
  });

  it("keeps a losing forwarder's OWN submitted prices, with the reason above them", () => {
    // DELIBERATELY REVERSED in review round 1 (MINOR 3). This assertion used to be
    // `queryByText(/quote submitted/i)).not.toBeInTheDocument()` — i.e. the closed branch REPLACED
    // the QUOTED one. That was wrong: a forwarder who submitted and then lost still owns their own
    // submitted prices, which are their commercial record and no competitor's information. The
    // brief's "above both" ordering is what is actually required, and it is what is asserted now.
    renderLeg({ ...quotedLeg, closedReason: CLOSED } as unknown as FfPortalLegDto);
    const reason = screen.getByText(CLOSED);
    const summary = screen.getByText(/quote submitted/i);
    expect(summary).toBeInTheDocument();
    expect(reason.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Visible, but not actionable: nothing offers to change or re-submit it.
    expect(screen.queryByRole("button", { name: /submit quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save draft/i })).not.toBeInTheDocument();
  });

  it("keeps the price of a losing forwarder whose own quote is REQUOTED or EXPIRED, and shows no summary when they never submitted", () => {
    // Final whole-branch review, MINOR. The closed branch gated its summary on
    // `status === "QUOTED"`, which dropped it for precisely the forwarders D4 preserved a price
    // for: a REQUOTED one (submitted, asked to revise, then lost the leg) and D4's scenario-B
    // EXPIRED one (same, and the window then closed). Both still hold a real submitted number on
    // the row, and both were shown a bare manifest instead.
    for (const status of ["REQUOTED", "EXPIRED"] as const) {
      const { unmount } = renderLeg({
        ...requotedLegWithDraft,
        status,
        closedReason: CLOSED,
      } as unknown as FfPortalLegDto);
      const reason = screen.getByText(CLOSED);
      const summary = screen.getByText(/quote submitted/i);
      // The retained draft's own chargeable weight, read off the summary's own cell rather than
      // by substring — the card's chrome renders either way, so only a real number proves the
      // draft (and not `draftFromDto`'s blank fallback) is what was rendered.
      expect(screen.getByTestId("total-chargeable").querySelector("dd")?.textContent).toBe(
        "1250.000",
      );
      expect(reason.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      unmount();
    }

    // POSITIVE CONTROL — the same two statuses with NO retained draft. `AlreadySubmittedSummary`
    // falls back to `draftFromDto`, so widening this branch on status alone would render a blank,
    // zeroed "Quote submitted" card to a forwarder who never submitted anything. It must not.
    for (const status of ["REQUOTED", "EXPIRED"] as const) {
      const { unmount } = renderLeg({
        ...leg,
        status,
        draft: null,
        closedReason: CLOSED,
      } as unknown as FfPortalLegDto);
      expect(screen.getByText(CLOSED)).toBeInTheDocument();
      expect(screen.queryByText(/quote submitted/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("the collapsed header does not contradict the body it hides", () => {
    // Review round 1, MINOR 2 — a closed loser's own quote is still RFQ_SENT, whose badge reads
    // "Open for quoting". Collapsed, that was the only thing on screen, and it said the opposite
    // of the body one click away.
    const closed = {
      ...leg,
      status: "RFQ_SENT",
      closedReason: CLOSED,
    } as unknown as FfPortalLegDto;
    const { unmount } = render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={closed}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={false}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.queryByText("Open for quoting")).not.toBeInTheDocument();
    expect(screen.getByText("Closed for quoting")).toBeInTheDocument();
    // Still neutral: the badge says nothing about who was selected or that anything was awarded.
    expect(screen.queryByText(/award/i)).not.toBeInTheDocument();
    unmount();

    // Control: an ordinary open leg keeps its original badge.
    renderLeg({ ...leg, status: "RFQ_SENT", closedReason: null } as unknown as FfPortalLegDto);
    expect(screen.getByText("Open for quoting")).toBeInTheDocument();
  });

  it("control: closedReason null leaves the editable form exactly as it was", () => {
    renderLeg({ ...leg, closedReason: null } as unknown as FfPortalLegDto);
    expect(screen.queryByText(CLOSED)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeInTheDocument();
  });
});

describe("LegSection save-draft failure surfacing (review round 1, MINOR 4)", () => {
  it("shows the server's refusal when Save draft fails, instead of failing silently", async () => {
    // Before round 1 `onSaveDraft` passed only an `onSuccess`, so any refused save — including
    // S5.9.5 D5's new closed-leg 409 — produced nothing on screen at all; the only cue was a
    // "Saved ✓" timestamp that never appeared.
    const message = "This leg is no longer open for quoting — a forwarder has been selected.";
    const fx = mockFetch((_url, init) =>
      init?.method === "PATCH" ? { status: 409, body: { message } } : { status: 200, body: {} },
    );
    vi.stubGlobal("fetch", fx);
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("control: a successful save shows no error", async () => {
    const fx = mockFetch(() => ({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fx);
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("LegSection legacy (pre-v2) manifest guard", () => {
  it("shows the re-issue notice instead of crashing when the manifest predates the v2 model", () => {
    const legacyLeg = {
      ...leg,
      // Pre-v2 frozen snapshot: cargo is not the per-package array the v2 UI expects.
      manifest: { cargo: { legacy: true } },
    } as unknown as FfPortalLegDto;
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legacyLeg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    // Degrades to the friendly notice for just this leg — no throw, no quote form.
    expect(screen.getByText(/created before a system update/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit quote/i })).not.toBeInTheDocument();
  });
});

describe("LegSection readOnly", () => {
  it("disables the Submit button when readOnly=true", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={true}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeDisabled();
  });
});

describe("LegSection sections & layout (design §6 finding #7)", () => {
  it("groups the quote form into labelled sections", () => {
    render(
      wrap(
        // Warehouse-inclusive fixture: this test asserts every section heading renders, which for
        // Warehousing is only true when the leg actually has a warehouse (see the dedicated
        // "warehouse section" describe block below for the conditional itself).
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithWarehouse}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.getByRole("heading", { name: /cargo & weight/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^charges$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /warehousing/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /transit plan/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^notes$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^terms$/i })).toBeInTheDocument();
  });
});

describe("LegSection warehouse section (design §6C finding #7)", () => {
  it("renders no Warehousing heading/section when the leg has no warehouse", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.queryByRole("heading", { name: /warehousing/i })).not.toBeInTheDocument();
  });

  it("renders the Warehousing heading/section when the leg has a warehouse", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithWarehouse}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.getByRole("heading", { name: /warehousing/i })).toBeInTheDocument();
  });
});

describe("LegSection notes (design §6 finding #5)", () => {
  it("renders a Notes textarea, positioned immediately before the Accept-terms control", async () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    const notes = screen.getByLabelText(/^notes$/i);
    // showDgNote is false for this fixture (no DG-tagged cargo), so the Accept-terms checkbox is
    // the only checkbox on the page.
    const acceptTerms = screen.getByRole("checkbox");

    // DOM order: Notes precedes the Accept-terms control.
    expect(
      notes.compareDocumentPosition(acceptTerms) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await userEvent.type(notes, "Handle with care");
    expect(notes).toHaveValue("Handle with care");
  });

  it("includes the typed Notes value in the saved draft payload", async () => {
    const fx = mockFetch(() => ({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fx);
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    await userEvent.type(screen.getByLabelText(/^notes$/i), "Fragile");
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));

    expect(fx).toHaveBeenCalledTimes(1);
    const [, init] = fx.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.notes).toBe("Fragile");
  });
});

// ── Round 4, #1/#2: accordion header + open-gating (design §4.8) ────────────────────────────
describe("LegSection accordion header (design §4.8 finding #1)", () => {
  // The base `leg` fixture above only populates manifest.cargo (irrelevant to the header) — build
  // a fuller one here so the header's leg-code/route/status text is actually checkable.
  const legWithHeader = {
    ...leg,
    manifest: {
      ...leg.manifest,
      legCode: "AIR-1",
      origin: { country: "IN", name: "Mumbai WH", city: "Mumbai" },
      destination: { country: "AE", name: "Dubai Airport", city: "Dubai" },
    },
  } as unknown as FfPortalLegDto;

  it("shows the header (leg code, route, status) even when collapsed (open=false)", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithHeader}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={false}
          onOpen={() => {}}
        />,
      ),
    );
    const header = screen.getByRole("button", { name: /AIR-1/, expanded: false });
    expect(header).toHaveTextContent("AIR-1");
    expect(header).toHaveTextContent(/Mumbai WH.*Dubai Airport/);
    expect(header).toHaveTextContent(/open for quoting/i);
  });

  it("hides the leg body when collapsed (open=false) — no Submit button, no form sections", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithHeader}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={false}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: /submit quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /cargo & weight/i })).not.toBeInTheDocument();
  });

  it("shows the leg body when open=true (the header stays too)", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithHeader}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AIR-1/, expanded: true })).toBeInTheDocument();
  });

  it("calls onOpen when the collapsed header is clicked", async () => {
    const onOpen = vi.fn();
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithHeader}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={false}
          onOpen={onOpen}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /AIR-1/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("a QUOTED (terminal) leg is also collapsible — header shows even when closed, summary hidden", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={quotedLeg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={false}
          onOpen={() => {}}
        />,
      ),
    );
    // Header renders (an aria-expanded=false toggle exists) even though the leg is QUOTED...
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    // ...but AlreadySubmittedSummary's own body is hidden until opened.
    expect(screen.queryByText(/quote submitted/i)).not.toBeInTheDocument();
  });
});

// ── Round 4, #1: findingNav force-opens a leg before scrolling ──────────────────────────────
describe("LegSection findingNav force-open (design §4.8 finding #1)", () => {
  it("calls onOpen when a validation finding is clicked (force-open before scroll)", async () => {
    const onOpen = vi.fn();
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={onOpen}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));
    const alert = await screen.findByRole("alert");
    const findingButton = within(alert).getAllByRole("button")[0];

    await userEvent.click(findingButton);

    expect(onOpen).toHaveBeenCalled();
  });
});
