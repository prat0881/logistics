# Contact affordance & discard guard — Design

**Date:** 2026-09-01
**Branch:** `claude/master-data-consistency-a920af` (PR #55, open)
**Predecessor:** `docs/2026-08-31-master-data-consistency-design.md`

## 1. Why this exists

Two problems, reported after using the rebuilt master screens.

**The contacts table looks read-only.** The user could not find edit or remove. Both work — the
name cell is a `<button>` that opens the dialog prefilled, and Remove lives inside that dialog —
but nothing on screen says so. This is a discoverability defect, not a missing feature, and the
correct user reaction to that UI is to conclude the feature is absent.

**Cancel discards silently.** All six master forms navigate away on Cancel with no warning, even
with unsaved changes. `formState.isDirty` is consulted nowhere in the feature.

## 2. Root cause of the first problem

Every list page in the app styles a clickable record name identically:

```
className="font-medium text-primary hover:underline"
```

(`ClientsListPage.tsx:66`, `VesselsListPage.tsx:67`, `WarehousesListPage.tsx:67`,
`FreightForwardersListPage.tsx:64`, `ChargeCatalogueListPage.tsx:179`)

The two child tables built in this branch use:

```
className="font-medium underline-offset-4 hover:underline"
```

(`contacts/ContactsSection.tsx:96`, `warehouses/VehiclesSection.tsx:63`)

The difference is exactly **`text-primary`** — the colour that marks a control as a link at rest.
Without it the name renders as ordinary body text and only reveals itself on hover. The app
already has an established clickable-name idiom; these two tables are the only places that do not
follow it.

So the fix is to adopt the existing pattern, not to invent a new highlight.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Style only. No Edit/Remove action buttons, no dialog changes.** | The user confirmed the existing interaction is fine once visible: *"we are good for edit and remove contacts but if we can highlight contact name as clickable will be good"*. Adding an actions column would be building a second way to do what already works. |
| D2 | **Vehicles gets the same one-class fix** | Same divergence, same cause, same screen. The user asked for it explicitly: *"No changes needed as edit opening the pop-up and remove is there. highlight the clickable field"*. |
| D3 | **The discard guard lives in `MasterForm`, not in each page** | `MasterForm` owns the Cancel button, so all six masters get the guard by construction. This branch already carries three near-verbatim duplications of submit logic that were deliberately not extracted; a fourth copy across six files would be worse. |
| D4 | **Guard the Cancel button only — not navigation, back or refresh** | User's choice. Intercepting route changes needs a react-router blocker plus `beforeunload`, with its own edge cases, and can trap a user who genuinely wants to leave. Recorded as a known limitation, not an oversight. |
| D5 | **Confirm with `ui/dialog`, not `window.confirm`** | Consistent with `ContactDialog`/`VehicleDialog` on the same screens, themable, and testable through the same queries as the rest of the suite. |
| D6 | **The button gains `aria-label={\`Edit ${name}\`}`** | Its accessible name is currently just the contact's name, which does not convey that activating it edits. The existing tests match `/asha menon/i`, which the new label still contains, so no assertion weakens. |

## 4. Part A — the clickable-name affordance

`contacts/ContactsSection.tsx` and `warehouses/VehiclesSection.tsx`: change the name/tonnage cell
button's class to `font-medium text-primary hover:underline`, and add the `aria-label`.

`lockedFirstRow` behaviour is unchanged — the Freight Forwarder's mirrored primary row at index 0
still renders as plain text with no button, because it is edited through the `pic`/`contactNumber`/
`email` fields above the table rather than through the dialog.

## 5. Part B — the discard guard

`MasterForm` gains one required prop:

```ts
MasterForm({ title, error?, banner?, onSubmit, isSubmitting, onCancel, isDirty, children })
```

Behaviour on Cancel:

- `isDirty === false` → call `onCancel()` immediately, exactly as today.
- `isDirty === true` → open a confirm dialog. **Keep editing** closes it and changes nothing.
  **Discard** calls `onCancel()`.

Copy: title *"Discard unsaved changes?"*, body *"Your changes to this {noun} will not be saved."*
The noun comes from a new optional `recordNoun` prop defaulting to `"record"`, so the six pages
read naturally ("this client", "this warehouse") without another required argument.

Each of the six form pages passes `isDirty` from its own `formState`. Nothing else changes on
them.

**Why `isDirty` covers the children:** `contacts`, `vehicles` and `warehouseIds` are all edited
through `Controller`, and react-hook-form marks controlled fields dirty like any other. A
contacts-only edit therefore arms the guard — that is the non-obvious half and it gets its own
test.

## 6. Known limitation, deliberately accepted

The edit pages call `reset()` a second time when a dependent query resolves (Freight Forwarder's
contacts query; the owner-warehouses query on Client and FF). If that lands after the user has
begun editing, it already discards their edits today — this branch's deferred follow-up #8 in
`docs/Masters - Session Handoff.md`. `isDirty` inherits the same weakness: the reset also clears
the dirty flag, so within that window Cancel would not warn.

This is **not** made worse by the present change, and its real fix is item #8's — guarding
`reset()` on `isDirty`. Out of scope here; recorded so it is not rediscovered as a new defect.

## 7. Testing

**Part A** — one assertion per table that the name button carries `text-primary`, so a future
restyle that drops it fails rather than silently reverting to invisible.

**Part B** — in `MasterForm.test.tsx`: a dirty form shows the dialog and does **not** call
`onCancel`; **Keep editing** dismisses without calling it; **Discard** calls it; a clean form
calls it immediately with no dialog. Plus one page-level test on a contacts-bearing form proving
that editing **only** a contact arms the guard.

`isDirty` is a **required** prop, so `MasterForm.test.tsx`'s three existing `<MasterForm>` render
sites must each pass it. Extend that file — do not replace it; it currently holds **7 `it(`
blocks** (3 under `describe("MasterForm")`, 4 under `describe("SelectField")`) and every one must
survive. The three existing cases pass `isDirty={false}`, preserving exactly the behaviour they
already assert.

## 8. Out of scope

- Edit/Remove action buttons or any dialog change (D1).
- Route, back-button and refresh guarding (D4).
- Fixing the `reset()`-clobbers-edits interaction (§6).
- Any API, schema or migration change. This is web-only.
