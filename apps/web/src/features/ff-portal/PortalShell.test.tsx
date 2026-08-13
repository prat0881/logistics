import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortalShell } from "./PortalShell";
import type { FfPortalRfqDto, FfPortalLegDto } from "@svyft/shared";

const rfq = {
  rfqNumber: "R-42",
  incoterms: "FOB",
  submissionDeadline: "2026-08-03T00:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2026-09-01T00:00:00.000Z",
  freightForwarder: { companyName: "Acme Freight" },
  legs: [],
} as FfPortalRfqDto;

describe("PortalShell countdown", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-08-01T00:00:00.000Z")));
  afterEach(() => vi.useRealTimers());

  it("renders company, RFQ number, incoterms and a countdown", () => {
    render(
      <PortalShell
        rfq={rfq}
        currency="USD"
        onCurrencyChange={() => {}}
        quoteValidityUntil={rfq.quoteValidityUntil}
        onValidityChange={() => {}}
      >
        x
      </PortalShell>,
    );
    expect(screen.getByText(/Acme Freight/)).toBeInTheDocument();
    expect(screen.getByText("R-42")).toBeInTheDocument();
    expect(screen.getByText("FOB")).toBeInTheDocument();
    expect(screen.getByText("2d 00h 00m")).toBeInTheDocument();
  });
});

describe("PortalShell interactions", () => {
  it("shows the passed currency in the select trigger", () => {
    render(
      <PortalShell
        rfq={rfq}
        currency="EUR"
        onCurrencyChange={() => {}}
        quoteValidityUntil={null}
        onValidityChange={() => {}}
      >
        x
      </PortalShell>,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("EUR");
  });

  it("calls onCurrencyChange when a currency is selected", async () => {
    const user = userEvent.setup();
    const onCurrencyChange = vi.fn();
    render(
      <PortalShell
        rfq={rfq}
        currency="USD"
        onCurrencyChange={onCurrencyChange}
        quoteValidityUntil={null}
        onValidityChange={() => {}}
      >
        x
      </PortalShell>,
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "EUR" }));
    expect(onCurrencyChange).toHaveBeenCalledWith("EUR");
  });

  it("calls onValidityChange with an ISO instant when a date is set", () => {
    const onValidityChange = vi.fn();
    render(
      <PortalShell
        rfq={rfq}
        currency="USD"
        onCurrencyChange={() => {}}
        quoteValidityUntil={null}
        onValidityChange={onValidityChange}
      >
        x
      </PortalShell>,
    );
    const input = screen.getByLabelText(/validity/i);

    fireEvent.change(input, { target: { value: "2026-09-15" } });
    expect(onValidityChange).toHaveBeenCalledWith(expect.stringMatching(/^2026-09-15T/));
  });

  it("calls onValidityChange with null when the date is cleared", () => {
    const onValidityChange = vi.fn();
    render(
      <PortalShell
        rfq={rfq}
        currency="USD"
        onCurrencyChange={() => {}}
        quoteValidityUntil="2026-09-15T00:00:00.000Z"
        onValidityChange={onValidityChange}
      >
        x
      </PortalShell>,
    );
    const input = screen.getByLabelText(/validity/i);

    fireEvent.change(input, { target: { value: "" } });
    expect(onValidityChange).toHaveBeenCalledWith(null);
  });
});

// ── RFQ PDF download + preview (design §4.8.14, Unit-4 Task 18) ──────────────────────────
const rfqWithLeg: FfPortalRfqDto = {
  ...rfq,
  legs: [
    {
      legId: "L1",
      quoteId: "Q1",
      status: "RFQ_SENT",
      mode: "AIR",
      manifest: {
        legId: "L1",
        legCode: "LEG-01",
        legName: null,
        mode: "AIR",
        incoterms: null,
        origin: null,
        destination: null,
        readyDate: null,
        targetDelivery: null,
        cargo: [],
        frozenAt: "2026-08-01T00:00:00.000Z",
      },
      endpoints: [],
      seededCharges: [],
      warehouseIncluded: true,
      draft: null,
    } satisfies FfPortalLegDto,
  ],
};

describe("PortalShell — RFQ PDF download + preview", () => {
  it("calls window.print when Download PDF is clicked", async () => {
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <PortalShell
        rfq={rfqWithLeg}
        currency="USD"
        onCurrencyChange={() => {}}
        quoteValidityUntil={null}
        onValidityChange={() => {}}
      >
        x
      </PortalShell>,
    );

    await user.click(screen.getByRole("button", { name: /download pdf/i }));

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });

  it("opens a read-only preview dialog showing the print view when Preview is clicked", async () => {
    const user = userEvent.setup();
    render(
      <PortalShell
        rfq={rfqWithLeg}
        currency="USD"
        onCurrencyChange={() => {}}
        quoteValidityUntil={null}
        onValidityChange={() => {}}
      >
        x
      </PortalShell>,
    );

    await user.click(screen.getByRole("button", { name: /preview/i }));

    const dialog = await screen.findByRole("dialog");
    // The print view's content (leg code from RfqPrintView) appears inside the dialog.
    expect(within(dialog).getByText("LEG-01")).toBeInTheDocument();
    // Read-only: no inputs/checkboxes inside the preview document itself.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });
});
