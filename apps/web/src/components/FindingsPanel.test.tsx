import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingsPanel } from "./FindingsPanel";
import type { Finding } from "@svyft/shared";

const blockingFinding: Finding = {
  rule: "R2",
  severity: "blocking",
  scope: { type: "cargo", id: "c1" },
  message: "Chain must end at a delivery",
};

const warningFinding: Finding = {
  rule: "W1",
  severity: "warning",
  scope: { type: "query" },
  message: "Check the departure time",
};

describe("FindingsPanel", () => {
  it("renders blocking findings prominently in create phase", () => {
    render(
      <FindingsPanel
        phase="create"
        findings={[blockingFinding]}
      />,
    );
    expect(screen.getByText(/must end at a delivery/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/R2/);
  });

  it("renders nothing when findings are empty", () => {
    const { container } = render(<FindingsPanel phase="draft" findings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders warning findings in draft phase", () => {
    render(<FindingsPanel phase="draft" findings={[warningFinding]} />);
    expect(screen.getByText(/Check the departure time/)).toBeInTheDocument();
    expect(screen.getByText("W1")).toBeInTheDocument();
  });

  it("deduplicates repeated findings", () => {
    const dup: Finding = { ...blockingFinding };
    render(
      <FindingsPanel
        phase="create"
        findings={[blockingFinding, dup]}
      />,
    );
    // Should only render one alert group (deduplicated)
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByText(/must end at a delivery/)).toHaveLength(1);
  });

  it("shows scope chip and calls onFindingClick when clicked", async () => {
    const onClick = vi.fn();
    render(
      <FindingsPanel
        phase="create"
        findings={[blockingFinding]}
        onFindingClick={onClick}
      />,
    );
    // Scope chip should show type and id
    const chip = screen.getByText(/cargo.*c1|c1.*cargo/i) ?? screen.getByTitle(/cargo/i);
    await userEvent.click(chip);
    expect(onClick).toHaveBeenCalledWith(blockingFinding);
  });

  it("renders the rule in a monospace tag", () => {
    render(<FindingsPanel phase="create" findings={[blockingFinding]} />);
    const ruleEl = screen.getByText("R2");
    expect(ruleEl).toBeInTheDocument();
    // Rule should be in a code/span with font-mono class
    expect(ruleEl.classList.toString()).toMatch(/mono/);
  });

  it("renders both blocking and warning when present", () => {
    render(
      <FindingsPanel
        phase="create"
        findings={[blockingFinding, warningFinding]}
      />,
    );
    expect(screen.getByText(/must end at a delivery/)).toBeInTheDocument();
    expect(screen.getByText(/Check the departure time/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("blocking group heading differs between create and draft phases", () => {
    const { unmount } = render(
      <FindingsPanel
        phase="create"
        findings={[blockingFinding, warningFinding]}
      />,
    );
    const createHeading = screen.getByText(/resolve to create the query/i);
    expect(createHeading).toBeInTheDocument();

    unmount();

    render(
      <FindingsPanel
        phase="draft"
        findings={[blockingFinding, warningFinding]}
      />,
    );
    // draft phase does NOT show the "resolve to create" text
    expect(screen.queryByText(/resolve to create the query/i)).not.toBeInTheDocument();
    // Both severities still render
    expect(screen.getByText(/must end at a delivery/)).toBeInTheDocument();
    expect(screen.getByText(/Check the departure time/)).toBeInTheDocument();
  });
});
