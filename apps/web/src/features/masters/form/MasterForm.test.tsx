import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { MasterForm, FormSection, Field, SelectField } from "./index";

describe("MasterForm", () => {
  it("renders the title, one alert region, and Save/Cancel", async () => {
    render(
      <MasterForm
        title="New client"
        error="Boom"
        onSubmit={vi.fn()}
        isSubmitting={false}
        onCancel={vi.fn()}
      >
        <FormSection title="Company">
          <Field id="companyName" label="Company name" error="Required">
            <input id="companyName" />
          </Field>
        </FormSection>
      </MasterForm>,
    );
    expect(screen.getByRole("heading", { name: "New client" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    // Exactly two alerts: the form-level one and the field-level one. This is the assertion
    // that would catch a regression back to a single page-level error summary — the masters
    // branch tried that and reversed it, because it left a 20-field form with no error
    // attached to any field.
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByLabelText("Company name")).toBeInTheDocument();
  });

  it("disables Save and shows progress while submitting", () => {
    render(
      <MasterForm title="T" onSubmit={vi.fn()} isSubmitting onCancel={vi.fn()}>
        <p>body</p>
      </MasterForm>,
    );
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
  });

  it("calls onCancel without submitting", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <MasterForm title="T" onSubmit={onSubmit} isSubmitting={false} onCancel={onCancel}>
        <p>body</p>
      </MasterForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// A small harness that produces a real react-hook-form `register()` return value for the
// `registration` prop — a hand-rolled { name, onChange, onBlur, ref } stub would pass these
// tests even if SelectField stopped working with the real thing.
function SelectFieldHarness({
  placeholder,
  error,
}: {
  placeholder?: string;
  error?: string;
} = {}) {
  const { register } = useForm<{ status: string }>();
  return (
    <SelectField
      id="status"
      label="Status"
      error={error}
      options={[
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ]}
      placeholder={placeholder}
      registration={register("status")}
    />
  );
}

describe("SelectField", () => {
  it("renders every option with its label as text and its value as the option value", () => {
    render(<SelectFieldHarness />);
    const alpha = screen.getByRole("option", { name: "Alpha" }) as HTMLOptionElement;
    const beta = screen.getByRole("option", { name: "Beta" }) as HTMLOptionElement;
    expect(alpha.value).toBe("a");
    expect(beta.value).toBe("b");
  });

  it("omits the placeholder option when placeholder is not passed", () => {
    render(<SelectFieldHarness />);
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.some((o) => o.value === "")).toBe(false);
  });

  it("renders an empty-value placeholder option when placeholder is an empty string", () => {
    render(<SelectFieldHarness placeholder="" />);
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.some((o) => o.value === "")).toBe(true);
  });

  it("renders the error as an alert and associates the label with the select", () => {
    render(<SelectFieldHarness error="Required" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
  });
});
