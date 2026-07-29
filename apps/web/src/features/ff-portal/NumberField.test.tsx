import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { NumberField } from "./NumberField";

// Stateful harness so typed digits accumulate in a controlled input.
// Without this, the pinned value={null} resets the field after each keystroke,
// causing onChange to fire with 4 then 2 instead of 42.
function Harness({ onChange }: { onChange: (v: number | null) => void }) {
  const [v, setV] = useState<number | null>(null);
  return (
    <NumberField
      aria-label="amt"
      value={v}
      onChange={(x) => { setV(x); onChange(x); }}
    />
  );
}

describe("NumberField", () => {
  it("emits a number when typed", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("amt"), "42");
    expect(onChange).toHaveBeenLastCalledWith(42);
  });

  it("emits null when the field is cleared", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByLabelText("amt");
    await userEvent.type(input, "5");
    await userEvent.clear(input);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
