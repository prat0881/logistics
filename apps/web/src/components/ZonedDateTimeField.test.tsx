// apps/web/src/components/ZonedDateTimeField.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { utcToZonedInput } from "@svyft/shared";
import { ZonedDateTimeField } from "./ZonedDateTimeField";

function Harness({ zone, initial, onValue, placeholderNoon }: { zone: string; initial?: string; onValue?: (v: string | undefined) => void; placeholderNoon?: boolean }) {
  const form = useForm({ defaultValues: { at: initial } });
  return (
    <Form {...form}>
      <ZonedDateTimeField
        control={form.control}
        name="at"
        label="Ready"
        zone={zone}
        placeholderNoon={placeholderNoon}
        onChanged={() => onValue?.(form.getValues("at") as string | undefined)}
      />
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

  it("defaults minutes to :00 when a value is first entered, but stays editable", async () => {
    const onValue = vi.fn();
    render(<Harness zone="Asia/Kolkata" onValue={onValue} />);
    const input = screen.getByLabelText("Ready");
    fireEvent.change(input, { target: { value: "2026-08-01T09:37" } });
    // stored UTC corresponds to 09:00 wall-clock, not 09:37
    expect(utcToZonedInput(onValue.mock.calls.at(-1)![0], "Asia/Kolkata")).toBe("2026-08-01T09:00");
    // editing again to :30 is respected (not re-zeroed)
    fireEvent.change(input, { target: { value: "2026-08-01T11:30" } });
    expect(utcToZonedInput(onValue.mock.calls.at(-1)![0], "Asia/Kolkata")).toBe("2026-08-01T11:30");
  });

  it("placeholderNoon shows a greyed 12:00 hint in an empty field WITHOUT setting the value", () => {
    render(<Harness zone="Asia/Kolkata" placeholderNoon />);
    const input = screen.getByLabelText("Ready") as HTMLInputElement;
    // The box displays a 12:00 hint (in the field's zone) instead of the browser's own empty look…
    expect(input.value.endsWith("T12:00")).toBe(true);
    // …but the form value stays empty, so the field submits blank until the user picks a time.
    expect(screen.getByTestId("val").textContent).toBe("");
    // Styled muted so it reads as a placeholder, not a set value (own token, not placeholder:*).
    expect(/(^|\s)text-muted-foreground(\s|$)/.test(input.className)).toBe(true);
  });

  it("placeholderNoon: picking a time replaces the hint with a real, zone-interpreted value", () => {
    render(<Harness zone="Asia/Kolkata" placeholderNoon />);
    const input = screen.getByLabelText("Ready") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-09-10T14:00" } });
    // 14:00 IST → 08:30 UTC; the ghost is gone and a real value is stored.
    expect(screen.getByTestId("val").textContent).toBe("2026-09-10T08:30:00.000Z");
    expect(/(^|\s)text-muted-foreground(\s|$)/.test(input.className)).toBe(false);
  });

  it("without placeholderNoon an empty field renders blank (no hint) — unchanged default", () => {
    render(<Harness zone="Asia/Kolkata" />);
    expect((screen.getByLabelText("Ready") as HTMLInputElement).value).toBe("");
  });
});
