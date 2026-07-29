import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { SubmissionBar } from "./SubmissionBar";

function Harness(props: Partial<React.ComponentProps<typeof SubmissionBar>>) {
  const form = useForm<QuoteDraft>({
    defaultValues: {
      legId: "L1",
      mode: "AIR",
      currency: "USD",
      quoteValidityUntil: null,
      cargo: [],
      charges: [],
      trucking: [],
      warehouse: [],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    },
  });
  return (
    <FormProvider {...form}>
      <SubmissionBar
        showDgNote={false}
        currency="USD"
        grandTotal={2800}
        saving={false}
        submitting={false}
        savedAt={null}
        disabled={false}
        onSaveDraft={() => {}}
        onSubmit={() => {}}
        {...props}
      />
    </FormProvider>
  );
}

/** Reads termsConditions out of the RHF context so we can assert on it. */
function TcWatcher() {
  const val = useWatch<QuoteDraft, "termsConditions">({ name: "termsConditions" });
  return <output data-testid="tc-val">{val ?? "NULL"}</output>;
}

function HarnessWithWatcher(
  props: Partial<React.ComponentProps<typeof SubmissionBar>>,
) {
  const form = useForm<QuoteDraft>({
    defaultValues: {
      legId: "L1",
      mode: "AIR",
      currency: "USD",
      quoteValidityUntil: null,
      cargo: [],
      charges: [],
      trucking: [],
      warehouse: [],
      transit: null,
      dgSurchargeNote: null,
      termsConditions: null,
    },
  });
  return (
    <FormProvider {...form}>
      <SubmissionBar
        showDgNote={false}
        currency="USD"
        grandTotal={2800}
        saving={false}
        submitting={false}
        savedAt={null}
        disabled={false}
        onSaveDraft={() => {}}
        onSubmit={() => {}}
        {...props}
      />
      <TcWatcher />
    </FormProvider>
  );
}

describe("SubmissionBar", () => {
  it("shows the grand total and fires callbacks", async () => {
    const onSaveDraft = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onSaveDraft={onSaveDraft} onSubmit={onSubmit} />);
    expect(screen.getByText("2,800.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));
    expect(onSaveDraft).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalled();
  });

  it("shows the currency code", () => {
    render(<Harness currency="EUR" />);
    expect(screen.getByText("EUR")).toBeInTheDocument();
  });

  it("shows the DG note field only when required", () => {
    const { rerender } = render(<Harness showDgNote={false} />);
    expect(screen.queryByLabelText(/dg surcharge note/i)).toBeNull();
    rerender(<Harness showDgNote={true} />);
    expect(screen.getByLabelText(/dg surcharge note/i)).toBeInTheDocument();
  });

  it("disables actions when disabled", () => {
    render(<Harness disabled={true} />);
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save draft/i })).toBeDisabled();
  });

  it("disables save button when saving", () => {
    render(<Harness saving={true} />);
    expect(screen.getByRole("button", { name: /save draft/i })).toBeDisabled();
  });

  it("disables submit button when submitting", () => {
    render(<Harness submitting={true} />);
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeDisabled();
  });

  it("shows Saved indicator when savedAt is set", () => {
    render(<Harness savedAt={Date.now()} />);
    expect(screen.getByText(/saved/i)).toBeInTheDocument();
  });

  it("toggling T&C checkbox writes 'Accepted' then null to termsConditions", async () => {
    render(<HarnessWithWatcher />);
    // Initially null
    expect(screen.getByTestId("tc-val").textContent).toBe("NULL");

    // Click the checkbox (label says "I accept the terms & conditions" or similar)
    const checkbox = screen.getByRole("checkbox");
    await userEvent.click(checkbox);
    expect(screen.getByTestId("tc-val").textContent).toBe("Accepted");

    // Click again to uncheck
    await userEvent.click(checkbox);
    expect(screen.getByTestId("tc-val").textContent).toBe("NULL");
  });
});
