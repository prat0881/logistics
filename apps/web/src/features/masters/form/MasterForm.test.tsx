import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MasterForm, FormSection, Field } from "./index";

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
