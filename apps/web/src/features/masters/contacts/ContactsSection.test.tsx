import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ContactsSection, type ContactDraft } from "./ContactsSection";

function Harness({
  initial = [] as ContactDraft[],
  lockedFirstRow = false,
}: {
  initial?: ContactDraft[];
  lockedFirstRow?: boolean;
}) {
  const [value, setValue] = useState<ContactDraft[]>(initial);
  return (
    <ContactsSection
      value={value}
      onChange={setValue}
      ownerNoun="client"
      lockedFirstRow={lockedFirstRow}
    />
  );
}

const asha: ContactDraft = {
  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  name: "Asha Menon",
  email: "asha@example.com",
  contactNo: "+971501234567",
  pocLevel: "PRIMARY",
};

const rahul: ContactDraft = {
  id: "9e0c4c1a-2a3b-4d5e-8f6a-1b2c3d4e5f60",
  name: "Rahul Sethi",
  email: "rahul@example.com",
  contactNo: "+971509998888",
  pocLevel: "SECONDARY",
};

describe("ContactsSection", () => {
  it("has no per-row action buttons — the row itself is the control", () => {
    render(<Harness initial={[asha]} />);
    expect(screen.queryByRole("button", { name: /^edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^remove/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /asha menon/i })).toBeInTheDocument();
  });

  it("adds a contact through the dialog", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), "New Person");
    await userEvent.type(screen.getByLabelText(/designation/i), "Ops Manager");
    await userEvent.type(screen.getByLabelText(/email/i), "new@example.com");
    await userEvent.type(screen.getByLabelText(/phone/i), "+971501112222");
    await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "PRIMARY");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));

    const table = screen.getByRole("table", { name: /contacts/i });
    expect(within(table).getByText("New Person")).toBeInTheDocument();
    expect(within(table).getByText("Ops Manager")).toBeInTheDocument();
  });

  it("opens the dialog prefilled when a row is selected", async () => {
    render(<Harness initial={[asha]} />);
    await userEvent.click(screen.getByRole("button", { name: /asha menon/i }));
    expect(screen.getByLabelText(/^name$/i)).toHaveValue("Asha Menon");
  });

  it("removes from inside the dialog, not from the row", async () => {
    render(<Harness initial={[asha]} />);
    await userEvent.click(screen.getByRole("button", { name: /asha menon/i }));
    await userEvent.click(screen.getByRole("button", { name: /remove contact/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i })); // confirm
    expect(screen.queryByText("Asha Menon")).not.toBeInTheDocument();
  });

  it("offers no Remove when adding a new contact", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    expect(screen.queryByRole("button", { name: /remove contact/i })).not.toBeInTheDocument();
  });

  // The rule that makes the API's 409 unreachable from the UI.
  it("demotes the incumbent when a second contact is set to PRIMARY", async () => {
    render(<Harness initial={[asha]} />);
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Newer Primary");
    await userEvent.type(screen.getByLabelText(/email/i), "np@example.com");
    await userEvent.type(screen.getByLabelText(/phone/i), "+971501112223");
    await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "PRIMARY");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));

    const rows = screen.getAllByRole("row").slice(1); // drop the header row
    const primaries = rows.filter((r) => within(r).queryByText("PRIMARY"));
    expect(primaries).toHaveLength(1);
    expect(within(primaries[0]).getByText(/newer primary/i)).toBeInTheDocument();
  });

  it("never calls fetch — every mutation is draft-only until the parent saves", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<Harness initial={[asha]} />);
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Nobody");
    await userEvent.type(screen.getByLabelText(/email/i), "n@example.com");
    await userEvent.type(screen.getByLabelText(/phone/i), "+971501112224");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));

    // Not just "fetch wasn't called" — the save must have actually landed in the draft, or
    // this test would also pass if validation silently swallowed the submission.
    const table = screen.getByRole("table", { name: /contacts/i });
    expect(within(table).getByText("Nobody")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  describe("lockedFirstRow", () => {
    it("renders row 0 as plain text, not a button, while later rows stay selectable", () => {
      render(<Harness initial={[asha, rahul]} lockedFirstRow />);
      expect(screen.queryByRole("button", { name: /asha menon/i })).not.toBeInTheDocument();
      expect(screen.getByText("Asha Menon")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /rahul sethi/i })).toBeInTheDocument();
    });

    // The off-by-one this guards against: row 0 being unselectable must not shift which
    // record row 1's button opens. If a future refactor of the row ternary mis-indexes,
    // this catches it by asserting on data unique to the second contact.
    it("opens the dialog on value[1], not value[0], when row 1 is selected", async () => {
      render(<Harness initial={[asha, rahul]} lockedFirstRow />);
      await userEvent.click(screen.getByRole("button", { name: /rahul sethi/i }));
      expect(screen.getByLabelText(/^name$/i)).toHaveValue("Rahul Sethi");
      expect(screen.getByLabelText(/email/i)).toHaveValue("rahul@example.com");
    });
  });
});
