import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { DensityChargeableGrid } from "./DensityChargeableGrid";

const cargo = [{ cargoItemId: "c1", poReference: "PO-1", productName: "Pumps", packageType: "Crate",
  isDangerous: false, qty: 1, dimL: "1", dimW: "1", dimH: "1", grossWt: "1500", volumeCbm: "2.5", hsCode: null, netWt: null }] as never;

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null,
    cargo: [{ cargoItemId: "c1", grossWtT: 1.5, cbm: 2.5, isDangerous: false, freightDensity: null }],
    charges: [], trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><DensityChargeableGrid cargo={cargo} /></FormProvider>;
}

describe("DensityChargeableGrid", () => {
  it("recomputes chargeable weight live when density changes", async () => {
    render(<Harness />);
    expect(screen.getByTestId("cw-c1")).toHaveTextContent("—");         // no density yet
    await userEvent.type(screen.getByLabelText(/density.*PO-1/i), "300"); // volumetric = 2.5*300/1000 = 0.75t < 1.5t gross
    expect(await screen.findByTestId("cw-c1")).toHaveTextContent("1.500"); // max(1.5, 0.75)
    await userEvent.clear(screen.getByLabelText(/density.*PO-1/i));
    await userEvent.type(screen.getByLabelText(/density.*PO-1/i), "1000"); // volumetric = 2.5t > 1.5t
    expect(await screen.findByTestId("cw-c1")).toHaveTextContent("2.500");
  });
});
