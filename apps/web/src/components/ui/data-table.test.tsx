import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable } from "./data-table";

const columns = [{ accessorKey: "code", header: "Code" }];

it("renders rows and fires onRowClick", async () => {
  const onRowClick = vi.fn();
  render(
    <DataTable
      columns={columns}
      data={[{ code: "YAL26-0001" }]}
      onRowClick={onRowClick}
    />,
  );
  await userEvent.click(screen.getByText("YAL26-0001"));
  expect(onRowClick).toHaveBeenCalledWith({ code: "YAL26-0001" });
});

it("shows an empty state", () => {
  render(<DataTable columns={columns} data={[]} />);
  expect(screen.getByText(/No results found/i)).toBeInTheDocument();
});
