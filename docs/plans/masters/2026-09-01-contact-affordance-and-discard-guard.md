# Contact Affordance & Discard Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the contacts and vehicles tables' clickable names look clickable, and stop the six master forms discarding unsaved changes silently on Cancel.

**Architecture:** Two independent changes. The first is a one-class styling fix in two files, adopting the clickable-name idiom every list page in the app already uses. The second adds a confirm dialog to `MasterForm`, which owns the Cancel button — so all six masters get the guard from one place rather than six copies.

**Tech Stack:** React 18, react-hook-form (`formState.isDirty`), shadcn `ui/dialog` and `ui/button`, Vitest + Testing Library.

**Spec:** `docs/2026-09-01-masters-contact-affordance-and-discard-guard-design.md`. Read decisions D1–D6 before starting.

## Global Constraints

- **Web-only. No API, schema or migration change.** This branch adds no migration and that must stay true. Do NOT run `prisma migrate dev` or `prisma format`.
- **Verify the branch before every commit:** `git branch --show-current` must print `claude/master-data-consistency-a920af`. If it prints anything else, STOP and report BLOCKED — HEAD drifts to `main` in this repo.
- Commands: `pnpm --filter @svyft/web test` (full suite, no path filter), `pnpm --filter @svyft/web typecheck`, `pnpm --filter @svyft/web lint`. There is no `test:e2e` script anywhere in this repo.
- **Do NOT run `pnpm run ci` or any api e2e suite.** Two concurrent `jest --runInBand` runs share one Postgres database and corrupt each other's fixtures. The controller runs CI.
- **Baseline: web 1043/1043 across 126 files, typecheck 0 errors, lint clean.** That is the bar; report the totals you get.
- **Check whether a file exists before writing it.** An earlier implementer on this branch used Write on a file it assumed was new and silently deleted eight passing tests. Report `it(` counts before and after for every test file you touch.
- **Do NOT add Edit/Remove action buttons or change either dialog** (spec D1). The user confirmed the existing interaction is correct once visible.
- Do not write auth-gated assertions as "wait for data, then synchronously assert gated UI" — that races `AuthProvider` and failed CI on a previous PR here. Await the element itself.

---

## File Structure

**Modified:**

| File | Change |
|---|---|
| `apps/web/src/features/masters/contacts/ContactsSection.tsx` | name-cell button: add `text-primary`, add `aria-label` |
| `apps/web/src/features/masters/warehouses/VehiclesSection.tsx` | tonnage-cell button: same |
| `apps/web/src/features/masters/form/MasterForm.tsx` | new `isDirty` / `recordNoun` props + confirm dialog |
| the six `*FormPage.tsx` | pass `isDirty` and `recordNoun` |
| `apps/web/src/features/masters/contacts/ContactsSection.test.tsx` | +1 assertion |
| `apps/web/src/features/masters/warehouses/VehiclesSection.test.tsx` | +1 assertion |
| `apps/web/src/features/masters/form/MasterForm.test.tsx` | 3 existing sites get `isDirty`; +5 tests |
| `apps/web/src/features/masters/clients/ClientFormPage.test.tsx` | +1 page-level test |

No files created, none deleted.

---

### Task 1: Make the clickable name look clickable

**Files:**
- Modify: `apps/web/src/features/masters/contacts/ContactsSection.tsx` (the name `<button>`)
- Modify: `apps/web/src/features/masters/warehouses/VehiclesSection.tsx` (the tonnage `<button>`)
- Test: `apps/web/src/features/masters/contacts/ContactsSection.test.tsx`, `apps/web/src/features/masters/warehouses/VehiclesSection.test.tsx` (both exist — extend)

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change. Purely presentational plus an accessible-name improvement.

**Why this is the whole fix.** Every list page in the app styles a clickable record name `font-medium text-primary hover:underline` (`ClientsListPage.tsx:66`, `VesselsListPage.tsx:67`, `WarehousesListPage.tsx:67`, `FreightForwardersListPage.tsx:64`, `ChargeCatalogueListPage.tsx:179`). These two tables use `font-medium underline-offset-4 hover:underline` — identical but for `text-primary`, the colour that marks a control as a link at rest. Without it the name is ordinary body text that only reveals itself on hover, which is why the user concluded edit and remove did not exist.

- [ ] **Step 1: Write the failing tests**

Append to `ContactsSection.test.tsx`, inside the existing top-level `describe("ContactsSection")`:

```tsx
  it("styles the contact name as a link so it reads as clickable", () => {
    render(<Harness initial={[asha]} />);
    const nameButton = screen.getByRole("button", { name: /asha menon/i });
    // `text-primary` is the app-wide affordance for a clickable record name — every list page
    // uses it. Dropping it is what made this table read as static text.
    expect(nameButton).toHaveClass("text-primary");
    expect(nameButton).toHaveAttribute("aria-label", "Edit Asha Menon");
  });
```

Append to `VehiclesSection.test.tsx`, inside its existing top-level describe. It already defines a
`Harness` component and a `fiveTonner` fixture (`tonnage: "T_5"`) — reuse them, do not add a second
fixture:

```tsx
  it("styles the tonnage as a link so it reads as clickable", () => {
    render(<Harness initial={[fiveTonner]} />);
    const tonnageButton = screen.getByRole("button", { name: /^edit /i });
    expect(tonnageButton).toHaveClass("text-primary");
  });
```

`truckTonnageLabel("T_5")` produces the visible text, so the accessible name becomes
`Edit <that label>`. Match on the `Edit ` prefix rather than hard-coding the label, so a label
change in `packages/shared` does not break this styling test.

- [ ] **Step 2: Run them and verify they fail**

Run: `pnpm --filter @svyft/web test -- src/features/masters/contacts src/features/masters/warehouses/VehiclesSection.test.tsx`
Expected: FAIL — the class assertion fails because the button has no `text-primary`, and the `aria-label` assertion fails because the attribute does not exist.

- [ ] **Step 3: Implement**

In `ContactsSection.tsx`, the name-cell button becomes:

```tsx
                    <button
                      type="button"
                      aria-label={`Edit ${c.name}`}
                      className="font-medium text-primary hover:underline"
                      onClick={() => setOpenIndex(i)}
                    >
                      {c.name}
                    </button>
```

In `VehiclesSection.tsx`, the tonnage-cell button becomes:

```tsx
                  <button
                    type="button"
                    aria-label={`Edit ${truckTonnageLabel(v.tonnage as TruckTonnage)}`}
                    className="font-medium text-primary hover:underline"
                    onClick={() => setOpenIndex(i)}
                  >
                    {truckTonnageLabel(v.tonnage as TruckTonnage)}
                  </button>
```

`lockedFirstRow` is untouched — the Freight Forwarder's mirrored primary row at index 0 still renders as plain text with no button, because it is edited through the `pic`/`contactNumber`/`email` fields above the table.

- [ ] **Step 4: Run the full web suite**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint`
Expected: all green. **Watch for pre-existing tests that query these buttons by accessible name** — adding `aria-label` changes the accessible name from `"Asha Menon"` to `"Edit Asha Menon"`. Queries matching `/asha menon/i` still pass (substring); an exact-string query would not. If any test breaks, fix the query, do not remove the label — and report which.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add apps/web/src/features/masters/contacts apps/web/src/features/masters/warehouses
git commit -m "fix(web): style contact and vehicle names as the links they are"
```

---

### Task 2: Confirm before discarding unsaved changes

**Files:**
- Modify: `apps/web/src/features/masters/form/MasterForm.tsx`
- Modify: all six form pages — `clients/ClientFormPage.tsx`, `freight-forwarders/FreightForwarderFormPage.tsx`, `warehouses/WarehouseFormPage.tsx`, `vessels/VesselFormPage.tsx`, `fx-rates/FxRateFormPage.tsx`, `charge-catalogue/ChargeLineFormPage.tsx`
- Test: `apps/web/src/features/masters/form/MasterForm.test.tsx` (exists — extend), `apps/web/src/features/masters/clients/ClientFormPage.test.tsx` (exists — extend)

**Interfaces:**
- Consumes: Task 1 nothing; `ui/dialog` (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`) and `ui/button`.
- Produces: `MasterForm({ title, error?, banner?, onSubmit, isSubmitting, onCancel, isDirty, recordNoun?, children })`. `isDirty` is **required**; `recordNoun` is optional and defaults to `"record"`.

**`isDirty` is required deliberately.** Making it optional would let a page silently opt out of the guard by forgetting it, which is exactly the failure this task exists to prevent. Required means the compiler names every page that has not been wired.

- [ ] **Step 1: Write the failing tests**

`MasterForm.test.tsx` currently holds **7 `it(` blocks** — 3 under `describe("MasterForm")`, 4 under `describe("SelectField")`. Extend it; every one must survive.

First, add `isDirty={false}` to the three existing `<MasterForm>` render sites (lines ~10, ~37, ~48). That preserves exactly the behaviour they already assert.

Then append to `describe("MasterForm")`:

```tsx
  it("cancels immediately when nothing has changed", async () => {
    const onCancel = vi.fn();
    render(
      <MasterForm title="T" onSubmit={vi.fn()} isSubmitting={false} onCancel={onCancel} isDirty={false}>
        <p>body</p>
      </MasterForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
  });

  it("asks before discarding when the form is dirty, and does not cancel yet", async () => {
    const onCancel = vi.fn();
    render(
      <MasterForm
        title="T"
        onSubmit={vi.fn()}
        isSubmitting={false}
        onCancel={onCancel}
        isDirty
        recordNoun="client"
      >
        <p>body</p>
      </MasterForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(await screen.findByText(/discard unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByText(/changes to this client will not be saved/i)).toBeInTheDocument();
    // The whole point: the record is still there to go back to.
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps editing when the user backs out of the discard prompt", async () => {
    const onCancel = vi.fn();
    render(
      <MasterForm title="T" onSubmit={vi.fn()} isSubmitting={false} onCancel={onCancel} isDirty>
        <p>body</p>
      </MasterForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await userEvent.click(await screen.findByRole("button", { name: /keep editing/i }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
  });

  it("discards when the user confirms", async () => {
    const onCancel = vi.fn();
    render(
      <MasterForm title="T" onSubmit={vi.fn()} isSubmitting={false} onCancel={onCancel} isDirty>
        <p>body</p>
      </MasterForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^discard$/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("falls back to a neutral noun when the page does not supply one", async () => {
    render(
      <MasterForm title="T" onSubmit={vi.fn()} isSubmitting={false} onCancel={vi.fn()} isDirty>
        <p>body</p>
      </MasterForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(await screen.findByText(/changes to this record will not be saved/i)).toBeInTheDocument();
  });
```

Note `/^discard$/i` is anchored — the dialog title contains the word "Discard", so an unanchored match would be ambiguous between the title and the button.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/web test -- src/features/masters/form`
Expected: FAIL — TypeScript rejects the unknown `isDirty` prop, and no discard dialog exists.

- [ ] **Step 3: Implement `MasterForm`**

```tsx
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function MasterForm({
  title,
  error,
  banner,
  onSubmit,
  isSubmitting,
  onCancel,
  isDirty,
  recordNoun = "record",
  children,
}: {
  title: string;
  error?: string | null;
  banner?: ReactNode;
  onSubmit: () => void;
  isSubmitting: boolean;
  onCancel: () => void;
  isDirty: boolean;
  recordNoun?: string;
  children: ReactNode;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        aria-label={title}
        className="max-w-3xl space-y-6"
      >
        <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {banner}
        {children}
        <div className="flex gap-2 border-t border-border pt-4">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => (isDirty ? setConfirmingDiscard(true) : onCancel())}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
        </div>
      </form>

      {/* Deliberately a sibling of the <form>, not a child. Radix renders DialogContent through
          a Portal, but React bubbles events through the REACT tree rather than the DOM tree —
          a dialog nested inside the form would route its clicks through that form's handlers.
          That exact bug bit ContactDialog on this branch and needed an explicit
          stopPropagation; keeping this outside the form means there is nothing to guard. */}
      <Dialog open={confirmingDiscard} onOpenChange={(open) => !open && setConfirmingDiscard(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your changes to this {recordNoun} will not be saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirmingDiscard(false)}>
              Keep editing
            </Button>
            <Button type="button" variant="destructive" onClick={onCancel}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 4: Wire all six pages**

Each page already destructures `formState`. Add `isDirty` to that destructure and pass both props to `MasterForm`. Nothing else on the pages changes.

For example, in `ClientFormPage.tsx` the destructure becomes:

```tsx
    formState: { errors, isSubmitting, isDirty },
```

and the element gains:

```tsx
      isDirty={isDirty}
      recordNoun="client"
```

Apply the same two edits to all six, with these nouns:

| Page | `recordNoun` |
|---|---|
| `clients/ClientFormPage.tsx` | `"client"` |
| `freight-forwarders/FreightForwarderFormPage.tsx` | `"freight forwarder"` |
| `warehouses/WarehouseFormPage.tsx` | `"warehouse"` |
| `vessels/VesselFormPage.tsx` | `"vessel"` |
| `fx-rates/FxRateFormPage.tsx` | `"FX rate"` |
| `charge-catalogue/ChargeLineFormPage.tsx` | `"charge line"` |

`FxRateFormPage` destructures from a `form` object created by `useForm` — read it first and add `isDirty` wherever that file already reads `isSubmitting`.

- [ ] **Step 5: Add the page-level test**

This is the non-obvious half: `contacts` is edited through a `Controller`, and the guard is worthless if controlled-field edits do not mark the form dirty. Append to `ClientFormPage.test.tsx`, in the edit describe:

```tsx
  it("arms the discard guard when only a contact was changed", async () => {
    // Loads a client, edits nothing but a contact through the dialog, then cancels.
    // `contacts` is Controller-managed, so this is what proves react-hook-form marks the form
    // dirty for controlled fields — without that, the guard silently never fires on the one
    // kind of edit these screens exist for.
    renderAtRoute("/masters/clients/c1");
    await userEvent.click(await screen.findByRole("button", { name: /edit asha menon/i }));
    const nameField = await screen.findByLabelText(/^name$/i);
    await userEvent.clear(nameField);
    await userEvent.type(nameField, "Asha Menon-Rao");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByText(/discard unsaved changes/i)).toBeInTheDocument();
  });
```

The file's render helper is **`renderAtRoute(initialEntry)`** — use it, not a new one. Its edit-mode
tests load a client whose contact is named **"Asha Menon"**; reuse that fixture rather than adding
another. Note the contact-row query is `/edit asha menon/i`, because Task 1 added that `aria-label`
— before Task 1 it would have been `/asha menon/i`.

If the edit describe has no loaded-contact fixture of its own, build the GET response the same way
the neighbouring edit tests do and give its contact the name "Asha Menon" for consistency.

- [ ] **Step 6: Run the full web suite**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint`
Expected: all green, 1043 + 6 new = **1049**, typecheck 0, lint clean. Any page still missing `isDirty` shows as a typecheck error naming that file.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add apps/web/src/features/masters
git commit -m "feat(web): confirm before discarding unsaved changes on the master forms"
```

---

## Post-implementation checklist

- [ ] `pnpm --filter @svyft/web test` green with no path filter; report the total.
- [ ] `pnpm --filter @svyft/web typecheck` and `lint` both clean.
- [ ] `git diff main --stat` touches only `apps/web/src/features/masters/` and the two docs — no `prisma/`, no `apps/api/`, no `packages/shared/`.
- [ ] Neither dialog gained or lost a button; no Edit/Remove action column exists (spec D1).
