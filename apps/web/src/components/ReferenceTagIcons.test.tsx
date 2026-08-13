import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReferenceTagIcons } from "./ReferenceTagIcons";

describe("ReferenceTagIcons", () => {
  it("renders an icon (by aria-label) for each reference tag incl. OUT_OF_GAUGE", () => {
    render(<ReferenceTagIcons tags={["HEAVY", "FRAGILE", "NON_STACKABLE", "OUT_OF_GAUGE"]} />);
    expect(screen.getByLabelText("Heavy")).toBeInTheDocument();
    expect(screen.getByLabelText("Fragile")).toBeInTheDocument();
    expect(screen.getByLabelText("Non Stackable")).toBeInTheDocument();
    expect(screen.getByLabelText("Out of Gauge Cargo")).toBeInTheDocument();
    expect(screen.queryByLabelText("Dangerous goods")).toBeNull();
  });

  it("renders the DG icon when DG is in tags", () => {
    render(<ReferenceTagIcons tags={["DG"]} />);
    expect(screen.getByLabelText("Dangerous Goods")).toBeInTheDocument();
  });

  it("returns null (empty) when tags=[] and not dangerous", () => {
    const { container } = render(<ReferenceTagIcons tags={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
