import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stepper } from "./stepper";

const steps = [
  { key: "a", label: "Client" },
  { key: "b", label: "Shipment" },
];

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
