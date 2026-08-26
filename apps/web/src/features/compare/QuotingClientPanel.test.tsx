import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import type { LegComparisonDto, QueryAwardSnapshot } from "@svyft/shared";
import { fetchJson } from "@/lib/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { fmtUsd } from "./money";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { QuotingClientPanel } from "./QuotingClientPanel";

afterEach(() => vi.unstubAllGlobals());

// Minimal leg shells — only `legId`/`legCode`/`origin`/`destination` matter here (leg lookup is
// unaffected by quote status, unlike forwarder lookup below), so `offers`/`pendingForwarders` are
// deliberately left empty: this fixture must NOT rely on any forwarder name being recoverable
// from them (review round 1 — that was the bug: the panel resolved names from `legs[].offers[]`).
// RE-TRACED at S5.9.5 (design D8): the reason used to be "leg-1's own winner is APPROVED, which
// COMPARABLE_STATUSES excludes from every offers/pendingForwarders list", and D8 added APPROVED to
// that list, so the premise is gone. The fixture is unchanged and still the right one — empty
// `offers` is precisely what makes this prove that `forwarderNames` (the query-wide,
// status-unfiltered map) is what resolves the name, independently of any status list.
const LEGS: LegComparisonDto[] = [
  {
    legId: "leg-1",
    legCode: "LEG-1",
    mode: "ROAD",
    origin: "Chennai",
    destination: "Mumbai",
    offers: [],
    pendingForwarders: [],
    awaitingReQuote: false,
    recommendation: null,
    decision: null,
    timeline: [],
  },
  {
    legId: "leg-2",
    legCode: "LEG-2",
    mode: "SEA",
    origin: "Mumbai",
    destination: "Rotterdam",
    offers: [],
    pendingForwarders: [],
    awaitingReQuote: false,
    recommendation: null,
    decision: null,
    timeline: [],
  },
];

const SNAPSHOT: QueryAwardSnapshot = {
  generatedByUserId: "u2",
  legs: [
    {
      legId: "leg-1",
      winningQuoteId: "quote-1",
      freightForwarderId: "ff-1",
      variant: "DEDICATED",
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 542.17,
      nativeTotal: 45000,
      transitDays: 3,
    },
    {
      legId: "leg-2",
      winningQuoteId: "quote-9",
      freightForwarderId: "ff-404", // deliberately absent from FORWARDER_NAMES below
      variant: "FCL",
      currency: "USD",
      unitsPerUsd: 1,
      usdTotal: 2100,
      nativeTotal: 2100,
      transitDays: 21,
    },
  ],
  combinedUsd: 2642.17,
};

// `ComparisonDto.forwarderNames` — server-built (review round 1) from EVERY quote on the query,
// no status filter, so it DOES cover an APPROVED winner. ff-1 is here (the leg-1 winner); ff-404
// deliberately is not, to prove the graceful-degrade path still works for a genuinely unresolvable
// id (e.g. a forwarder no longer on file at all).
const FORWARDER_NAMES: Record<string, string> = { "ff-1": "TCI Freight" };

// Mounted alongside the panel so the ["comparison", queryId]/["query", queryId] keys have an
// active observer — invalidateQueries only refetches ACTIVE queries by default, so without a
// live subscriber here, a bare call to qc.invalidateQueries would be a silent no-op and this test
// would prove nothing about the hook's onSuccess behaviour.
function Probes({ queryId }: { queryId: string }) {
  useQuery({
    queryKey: ["comparison", queryId],
    queryFn: () => fetchJson(`/api/queries/${queryId}/comparison`),
  });
  useQuery({ queryKey: ["query", queryId], queryFn: () => fetchJson(`/api/queries/${queryId}`) });
  return null;
}

/** Renders a value that only exists once `AuthProvider` has actually resolved — so an absence
 *  assertion about a ROLE-gated control (the Executive test below) can be taken after auth has
 *  settled, rather than passing spuriously while `useAuth()`'s `user` is still `null`. Same
 *  pattern as `ComparisonGrid.test.tsx`'s own `AuthProbe`. */
function AuthProbe() {
  const { user, loading } = useAuth();
  return <span data-testid="auth-probe">{loading ? "loading" : (user?.role ?? "anonymous")}</span>;
}

function renderPanel(
  opts: { reopenResponse?: { status: number; body?: unknown }; role?: string } = {},
) {
  // `bodies` (S5.9.5 Task 10) — the old handler counted calls and threw the payload away, which is
  // why the test titled "posts reopen-comparison with no body" could never have caught a body
  // appearing. Reopen now carries a required reason (D6), so the payload is captured and asserted.
  const calls = { comparison: 0, query: 0, reopen: 0, reopenBodies: [] as unknown[] };
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith("/reopen-comparison") && init?.method === "POST") {
        calls.reopen++;
        calls.reopenBodies.push(init.body ? JSON.parse(init.body as string) : undefined);
        return opts.reopenResponse ?? { status: 200, body: {} };
      }
      if (url.endsWith("/api/queries/q1/comparison")) {
        calls.comparison++;
        return {
          status: 200,
          body: {
            queryId: "q1",
            priority: "MEDIUM",
            fxAsOf: null,
            legs: [],
            awardSnapshot: null,
            forwarderNames: {},
          },
        };
      }
      if (url.endsWith("/api/queries/q1")) {
        calls.query++;
        return { status: 200, body: { id: "q1" } };
      }
      return { status: 404 };
    }),
  );
  const result = renderWithProviders(
    <>
      <Probes queryId="q1" />
      <AuthProbe />
      <QuotingClientPanel
        queryId="q1"
        snapshot={SNAPSHOT}
        legs={LEGS}
        forwarderNames={FORWARDER_NAMES}
        fxAsOf="2026-08-14T00:00:00.000Z"
      />
    </>,
    // MANAGER by default (S5.9.5 Task 10): D6 put `@Roles(ADMINISTRATOR, MANAGER)` on
    // `reopen-comparison`, and this panel now hides the control from anyone else — so an EXECUTIVE
    // default would leave every Reopen test below with no button to click. The Executive case is
    // its own test instead.
    { user: { id: "u1", name: "Viewer", email: "e@x.com", role: opts.role ?? "MANAGER" } },
  );
  return { ...result, calls };
}

/** The Reopen control is auth-gated now, so every test that clicks it must wait for
 *  `AuthProvider`'s `/api/auth/me` round trip to settle first. */
function reopenButton() {
  return screen.findByRole("button", { name: /reopen comparison/i });
}

describe("QuotingClientPanel", () => {
  it("renders every winner's real forwarder name (including the APPROVED leg-1 winner) + variant + USD, and the combined USD total", async () => {
    renderPanel();

    // The happy path: leg-1's winner resolves to its real name via forwarderNames, NOT via any
    // offer/pendingForwarders lookup (LEGS carries none) — this is the case review round 1 found
    // broken (every single-leg query rendered "Unknown forwarder" here before the fix).
    expect(await screen.findByText(/TCI Freight — Dedicated/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(fmtUsd(542.17).replace("$", "\\$")))).toBeInTheDocument();
    expect(screen.getByText(/3 days/)).toBeInTheDocument();

    expect(screen.getByText(fmtUsd(SNAPSHOT.combinedUsd))).toBeInTheDocument();
    expect(screen.getByText(/LEG-1/)).toBeInTheDocument();
    expect(screen.getByText(/LEG-2/)).toBeInTheDocument();
  });

  it("degrades to a generic label for a forwarder id genuinely absent from forwarderNames, without crashing", async () => {
    renderPanel();

    // leg-2's winner (ff-404) has no entry in FORWARDER_NAMES at all — proves the fallback still
    // fires for a real miss, not just the (now-fixed) common case.
    expect(await screen.findByText(/Unknown forwarder — FCL/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(fmtUsd(2100).replace("$", "\\$")))).toBeInTheDocument();
  });

  // RETITLED (S5.9.5 Task 10) — this was "posts reopen-comparison with no body and refreshes…",
  // which stopped being true when D6 gave reopen a required reason, and had never been asserted
  // anyway (the old handler discarded the payload). What it actually covers, and now says, is the
  // click → mutation → both-keys invalidation wiring; the wire format is the test below it.
  it("posts reopen-comparison once and refreshes the comparison + query reads", async () => {
    const { calls } = renderPanel();

    await waitFor(() => expect(calls.comparison).toBeGreaterThan(0));
    await waitFor(() => expect(calls.query).toBeGreaterThan(0));
    const before = { comparison: calls.comparison, query: calls.query };

    await userEvent.click(await reopenButton());
    await userEvent.type(screen.getByLabelText(/reason/i), "Client pushed the dates");
    await userEvent.click(screen.getByRole("button", { name: /^reopen$/i }));

    await waitFor(() => expect(calls.reopen).toBe(1));
    await waitFor(() => expect(calls.comparison).toBeGreaterThan(before.comparison));
    await waitFor(() => expect(calls.query).toBeGreaterThan(before.query));
  });

  it("S5.9.5 (D6) — Reopen collects a required reason and posts it", async () => {
    const { calls } = renderPanel();

    await userEvent.click(await reopenButton());
    await userEvent.click(screen.getByRole("button", { name: /^reopen$/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument(); // required-field error
    expect(calls.reopen).toBe(0);

    await userEvent.type(screen.getByLabelText(/reason/i), "Client pushed the dates");
    await userEvent.click(screen.getByRole("button", { name: /^reopen$/i }));

    await waitFor(() => expect(calls.reopen).toBe(1));
    expect(calls.reopenBodies).toEqual([{ reason: "Client pushed the dates" }]);
  });

  // D6 put `@Roles(ADMINISTRATOR, MANAGER)` on the route, so an Executive who clicked this could
  // only ever earn a 403. A ROLE rule hides (design D1), so the control is withheld rather than
  // rendered disabled.
  it("S5.9.5 (D6) — an Executive gets no Reopen control at all", async () => {
    renderPanel({ role: "EXECUTIVE" });

    // Positive control: wait for the SETTLED role, so this cannot pass merely because `useAuth()`
    // hadn't resolved yet — that shape passes identically whether the gate is correct or inverted.
    await screen.findByText("EXECUTIVE");
    expect(screen.queryByRole("button", { name: /reopen comparison/i })).not.toBeInTheDocument();
  });

  it("shows an inline error when reopen fails, without crashing", async () => {
    renderPanel({ reopenResponse: { status: 500, body: { message: "boom" } } });

    await userEvent.click(await reopenButton());
    await userEvent.type(screen.getByLabelText(/reason/i), "Client pushed the dates");
    await userEvent.click(screen.getByRole("button", { name: /^reopen$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/i);
  });
});
