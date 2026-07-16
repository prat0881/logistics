# Stage 3 — Session Handoff

> Use this to resume in a new session. It points to the deliverable and records the decisions + parked items so nothing has to be re-litigated.

## Where things stand
- **Stage 3 "Create Query" functional specification is complete and agreed.**
- Primary deliverable: **`Stage 3 - Create Query - Functional Spec.md`** (in this folder).
- The functional spec is **self-contained and the source of truth** — it **supersedes** the original Stage 3 PRD.
- Original inputs are **optional archive/reference, not needed to resume**: `Stage 3 - Create_Query.md` (superseded PRD) and `../Stage-0/Stage 0 - Logistics Module Overview.md` (module-wide context — more useful for Stages 4–9 than for Stage 3's plan).

## What the spec covers
Wizard flow (Query List → stepped Create Query), all 5 sections with full field tables, first-class reusable **points** + **plug-n-play manual legs**, the full **validation catalogue**, the query-wide **change-impact model**, **query vs leg status** (rollup), cargo tracking model, escalation, and email templates. See its §2 for the 12 key decisions (D1–D12).

## Key locked decisions (functional)
- Manual, plug-n-play legs — **no** Leg Generation Matrix, Multimodal Combination, or Service Type.
- **Points are first-class, reusable** objects; connectivity is by shared-point reference.
- **Mode is per-leg**; shipment "Freight Mode" is a derived read-only summary.
- **Cargo rows are atomic** (one pickup, one delivery); each row's legs form a simple chain.
- **Divergent routing allowed** (multiple hubs); hub effective date = MAX of feeding legs.
- Cargo attached to a leg by **explicit selection**; leg holds the full **cargo manifest** + roll-ups (Total Packages/CBM/Gross/Net) + **Total Chargeable Weight** (Σ).
- **Freight Density + Chargeable Weight are cargo-level**, empty in Stage 3, filled by the FF in Stage 4 (one value per row). **No density/DG at leg level.**
- **Legs saved individually** (stable IDs, partial legs allowed).
- **Change handling is query-wide + impact-aware** (free path pre-RFQ; change-order cascade post-RFQ, defined now / enforced later).
- **Tracking**: leg execution status → derived cargo position; model now, UI in Stage 8–9.
- Emails: **compose & log only** (no live send this phase).

## Parked technical / architecture decisions (deferred on purpose)
These were agreed earlier but intentionally kept out of the functional spec — revisit when building the plan:
- Stack: **Node + React**.
- Auth: **real login + RBAC** (Executive / Manager / Administrator).
- Tenancy: **single-tenant** (schema kept tenant-ready).
- Audit trail: **deferred**.
- Escalation scheduler + in-app notifications: **build now**.
- Build scope: **Stage 3 manual-create only** + build **Client & Vessel Masters** + **All-Records table**; no dependency on other stages.

## Open items to confirm (from spec §16)
- O1: Priority default = **Medium** (confirm).
- O2: Wizard step order = Client → Shipment → **Cargo → Legs** → Notes (confirm).
- O4: Freight density defaults are Admin-configurable reference data.
- O5: Lightweight change-log needed when the change-order cascade is built (audit is deferred).
- O6: Tracking UI deferred to Stage 8–9.

## Next step
Turn the functional spec into an **implementation plan** — this is where the parked technical/architecture decisions above come back in.

### To resume in a new session
Open a session in `Stage-3/` and say something like:
> "Read `Stage 3 - Create Query - Functional Spec.md` and `Stage 3 - Session Handoff.md`. The functional spec is agreed. Let's create the implementation plan — bring back the parked technical decisions (Node + React, real auth/RBAC, single-tenant, audit deferred, escalation now, email compose-&-log, Stage-3-only scope)."
