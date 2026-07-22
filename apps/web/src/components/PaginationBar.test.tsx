import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaginationBar } from "./PaginationBar";

describe("PaginationBar", () => {
  it("shows the result count and page position", () => {
    render(<PaginationBar page={2} pageSize={10} total={25} onPageChange={() => {}} onPageSizeChange={() => {}} />);
    expect(screen.getByText(/25 results/i)).toBeInTheDocument();
    expect(screen.getByText(/Page 2 of 3/i)).toBeInTheDocument();
  });
  it("disables Previous on page 1 and Next on the last page", () => {
    const { rerender } = render(<PaginationBar page={1} pageSize={10} total={25} onPageChange={() => {}} onPageSizeChange={() => {}} />);
    expect(screen.getByLabelText("Previous page")).toBeDisabled();
    rerender(<PaginationBar page={3} pageSize={10} total={25} onPageChange={() => {}} onPageSizeChange={() => {}} />);
    expect(screen.getByLabelText("Next page")).toBeDisabled();
  });
  it("emits the next page", async () => {
    const onPageChange = vi.fn();
    render(<PaginationBar page={1} pageSize={10} total={25} onPageChange={onPageChange} onPageSizeChange={() => {}} />);
    await userEvent.click(screen.getByLabelText("Next page"));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});
