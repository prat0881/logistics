import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortalLinkRow } from "./PortalLinkRow";
import * as clip from "@/lib/clipboard";

afterEach(() => vi.restoreAllMocks());

describe("PortalLinkRow", () => {
  it("renders the url in a readonly field and copies it", async () => {
    const spy = vi.spyOn(clip, "copyToClipboard").mockResolvedValue(true);
    render(<PortalLinkRow url="http://host/ff/rfq/TOK" />);
    expect(screen.getByLabelText(/portal link/i)).toHaveValue("http://host/ff/rfq/TOK");
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(spy).toHaveBeenCalledWith("http://host/ff/rfq/TOK");
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it("shows a fallback message when copy fails", async () => {
    vi.spyOn(clip, "copyToClipboard").mockResolvedValue(false);
    render(<PortalLinkRow url="http://host/ff/rfq/TOK" />);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(await screen.findByText(/couldn't copy/i)).toBeInTheDocument();
  });
});
