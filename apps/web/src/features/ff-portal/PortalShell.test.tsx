import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortalShell } from "./PortalShell";
import type { FfPortalRfqDto } from "@svyft/shared";

beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-08-01T00:00:00.000Z")));
afterEach(() => vi.useRealTimers());

const rfq = {
  rfqNumber: "R-42",
  incoterms: "FOB",
  submissionDeadline: "2026-08-03T00:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2026-09-01T00:00:00.000Z",
  freightForwarder: { companyName: "Acme Freight" },
  legs: [],
} as FfPortalRfqDto;

describe("PortalShell", () => {
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
    // Use fireEvent to avoid timer interaction issues with fake timers + Radix Select
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "GBP" }));
    expect(onCurrencyChange).toHaveBeenCalledWith("GBP");
  });
});
