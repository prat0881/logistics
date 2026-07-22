import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stepper } from "./stepper";

const steps = [
  { key: "a", label: "Client" },
  { key: "b", label: "Shipment" },
];

describe("Stepper badges", () => {
  it("renders a count badge on steps with badgeCount > 0 and none for 0/undefined", () => {
    render(
      <Stepper
        steps={[
          { key: "a", label: "Alpha", badgeCount: 2 },
          { key: "b", label: "Beta", badgeCount: 0 },
          { key: "c", label: "Gamma" },
        ]}
        current="a"
        completed={new Set()}
      />,
    );
    expect(screen.getByLabelText("Alpha: 2 issues")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Beta: .* issue/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Gamma: .* issue/)).not.toBeInTheDocument();
  });
});

it("marks current + completed and fires onStepClick", async () => {
  const onClick = vi.fn();
  render(
    <Stepper
      steps={steps}
      current="b"
      completed={new Set(["a"])}
      onStepClick={onClick}
    />,
  );
  expect(screen.getByRole("button", { name: /Client/ })).toHaveAttribute(
    "data-completed",
    "true",
  );
  expect(screen.getByRole("button", { name: /Shipment/ })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await userEvent.click(screen.getByRole("button", { name: /Client/ }));
  expect(onClick).toHaveBeenCalledWith("a");
});
