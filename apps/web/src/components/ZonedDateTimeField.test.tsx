// apps/web/src/components/ZonedDateTimeField.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { ZonedDateTimeField } from "./ZonedDateTimeField";

function Harness({ zone, initial }: { zone: string; initial?: string }) {
  const form = useForm({ defaultValues: { at: initial } });
  return (
    <Form {...form}>
      <ZonedDateTimeField control={form.control} name="at" label="Ready" zone={zone} />
      <output data-testid="val">{String(form.watch("at") ?? "")}</output>
    </Form>
  );
}

describe("ZonedDateTimeField", () => {
  it("shows the stored UTC instant as the zone's wall-clock", () => {
    render(<Harness zone="Asia/Kolkata" initial="2026-06-15T03:30:00.000Z" />);
    expect((screen.getByLabelText(/Ready/i) as HTMLInputElement).value).toBe("2026-06-15T09:00");
    expect(screen.getByText(/Times in Asia\/Kolkata \(GMT\+05:30\)/)).toBeInTheDocument();
  });
  it("shows the IANA zone + offset in the hint", () => {
    render(<Harness zone="Asia/Kolkata" initial="2026-06-15T03:30:00.000Z" />);
    expect(screen.getByText(/Times in Asia\/Kolkata \(GMT\+05:30\)/)).toBeInTheDocument();
  });
  it("writes back a UTC instant interpreted in the zone", () => {
    render(<Harness zone="Asia/Kolkata" />);
    fireEvent.change(screen.getByLabelText(/Ready/i), { target: { value: "2026-06-15T09:00" } });
    expect(screen.getByTestId("val").textContent).toBe("2026-06-15T03:30:00.000Z");
  });
});
