import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QueryLegDto, QueryPointDto, CargoDto, PackageDto } from "@svyft/shared";
import { PreviewRfqDialog } from "./PreviewRfqDialog";

const leg = {
  id: "l1",
  legCode: "L1",
  legName: "Air leg",
  mode: "AIR",
  originPointId: "p1",
  destinationPointId: "p2",
  assignedPackageIds: ["pk1"],
} as unknown as QueryLegDto;
const points = [
  { id: "p1", name: "PVG", country: "CN" },
  { id: "p2", name: "DXB", country: "AE" },
] as unknown as QueryPointDto[];

const makePackage = (over: Partial<PackageDto>): PackageDto => ({
  id: "pk1",
  rowIndex: 0,
  packageNo: "PKG-1",
  packageType: "CRATE",
  dimL: "100",
  dimW: "50",
  dimH: "40",
  grossWt: "500",
  netWt: "450",
  volumeCbm: "0.2",
  tags: [],
  effectiveTags: [],
  msdsFileId: null,
  items: [],
  ...over,
});

const makeCargo = (over: Partial<CargoDto>): CargoDto => ({
  id: "c1",
  rowIndex: 0,
  poReference: "PO-1",
  label: null,
  dimUnit: "CM",
  weightUnit: "KG",
  packages: [],
  packageCount: 0,
  grossWeightKg: "0",
  volumeCbm: "0",
  tags: [],
  chargeableWeight: null,
  ...over,
});

const cargo: CargoDto[] = [
  makeCargo({ id: "c1", packages: [makePackage({ id: "pk1", packageNo: "PKG-1" })] }),
  makeCargo({
    id: "c2",
    poReference: "PO-2",
    packages: [makePackage({ id: "pk2", packageNo: "PKG-2" })],
  }),
];

describe("PreviewRfqDialog", () => {
  it("renders only the leg's assigned packages", () => {
    render(
      <PreviewRfqDialog open onOpenChange={() => {}} leg={leg} points={points} cargo={cargo} />,
    );
    expect(screen.getByText("PKG-1")).toBeInTheDocument();
    expect(screen.queryByText("PKG-2")).not.toBeInTheDocument();
    expect(screen.getByText(/PVG/)).toBeInTheDocument();
  });

  it("converts dims to the cargo's entry unit and shows weights/volume", () => {
    const mmCargo: CargoDto[] = [
      makeCargo({
        id: "c1",
        dimUnit: "MM",
        packages: [
          makePackage({
            id: "pk1",
            packageNo: "PKG-1",
            packageType: "CRATE",
            dimL: "100",
            dimW: "50",
            dimH: "40",
            grossWt: "12.5",
            netWt: "10",
            volumeCbm: "0.2",
          }),
        ],
      }),
    ];
    render(
      <PreviewRfqDialog open onOpenChange={() => {}} leg={leg} points={points} cargo={mmCargo} />,
    );
    const row = screen.getByText("PKG-1").closest("tr")!;
    expect(row).toHaveTextContent("Crate");
    // canonical cm -> MM display is x10 (fromCanonicalDim)
    expect(row).toHaveTextContent("1000");
    expect(row).toHaveTextContent("500");
    expect(row).toHaveTextContent("400");
    expect(row).toHaveTextContent("12.50 kg");
    expect(row).toHaveTextContent("10.00 kg");
    expect(row).toHaveTextContent("0.2000");
  });

  it("shows a tag icon for a package's effective tags (e.g. DG)", () => {
    const dgCargo: CargoDto[] = [
      makeCargo({ id: "c1", packages: [makePackage({ id: "pk1", effectiveTags: ["DG"] })] }),
    ];
    render(
      <PreviewRfqDialog open onOpenChange={() => {}} leg={leg} points={points} cargo={dgCargo} />,
    );
    expect(screen.getByLabelText(/dangerous goods/i)).toBeInTheDocument();
  });

  it("shows an empty state when no packages are assigned to the leg", () => {
    const legNoAssign = { ...leg, assignedPackageIds: [] } as unknown as QueryLegDto;
    render(
      <PreviewRfqDialog
        open
        onOpenChange={() => {}}
        leg={legNoAssign}
        points={points}
        cargo={cargo}
      />,
    );
    expect(screen.getByText(/no cargo assigned/i)).toBeInTheDocument();
  });
});
