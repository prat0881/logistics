import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { WarehouseStaging } from "./WarehouseStaging";

function Harness({ wh }: { wh: QuoteDraft["warehouse"] }) {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null, cargo: [], charges: [], trucking: [],
    warehouse: wh, transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><WarehouseStaging /></FormProvider>;
}

describe("WarehouseStaging", () => {
  it("renders an amount + acceptance window per warehouse endpoint", () => {
    render(<Harness wh={[{ warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: null }]} />);
    expect(screen.getByText("Origin warehouse")).toBeInTheDocument();
    expect(screen.getByLabelText(/amount.*Origin warehouse/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/acceptance window.*Origin warehouse/i)).toBeInTheDocument();
  });
  it("renders nothing with no warehouse rows", () => {
    const { container } = render(<Harness wh={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
