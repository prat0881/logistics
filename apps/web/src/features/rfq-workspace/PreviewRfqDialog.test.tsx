import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QueryLegDto, QueryPointDto, CargoDto } from "@svyft/shared";
import { PreviewRfqDialog } from "./PreviewRfqDialog";

const leg = { id: "l1", legCode: "L1", legName: "Air leg", mode: "AIR",
  originPointId: "p1", destinationPointId: "p2", assignedCargoIds: ["c1"] } as unknown as QueryLegDto;
const points = [{ id: "p1", name: "PVG", country: "CN" }, { id: "p2", name: "DXB", country: "AE" }] as unknown as QueryPointDto[];
const cargo = [
  { id: "c1", poReference: "PO-1", productName: "Pumps", packageType: "CRATE", qty: 4, grossWt: "500", isDangerous: false },
  { id: "c2", poReference: "PO-2", productName: "Other", packageType: "BOX", qty: 1, grossWt: "10", isDangerous: false },
] as unknown as CargoDto[];

describe("PreviewRfqDialog", () => {
  it("renders only the leg's assigned cargo", () => {
    render(<PreviewRfqDialog open onOpenChange={() => {}} leg={leg} points={points} cargo={cargo} />);
    expect(screen.getByText("Pumps")).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
    expect(screen.getByText(/PVG/)).toBeInTheDocument();
  });
});
