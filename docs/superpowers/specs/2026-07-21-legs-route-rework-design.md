# Legs / Route screen rework — design

> Continuation of `feat/plan-6-wizard-ui-bugs` (Plan-6 testing round 2). Testing-team
> findings scoped to Step 4 (Legs / Route). Agreed via brainstorm 2026-07-21; implemented
> TDD-direct on the same branch.

## Findings (source)
1. Temporarily hide the "Validate route" button; run validation on Save/Next instead.
2. Remove the "Advisory Notices" list; show the error on the relevant route box with a hover tooltip carrying that block's message.
3. Screen order: notices → Points → Legs → Route.
4. Save & Next must not advance if there is any error on the screen.
5. Add/Edit Point & Leg must validate mandatory fields before save.

## Decisions (locked)
- **Findings display:** a compact **top summary strip** (holds query-scoped findings + a count) **+ per-box hover tooltips**. The standalone Blocking/Advisory *list* is removed at Step 4.
- **Validate strictness:** **create-phase** — every route issue is a blocking error.
- **Save behavior:** Save still **persists** the draft and shows errors; only **Next** is blocked from advancing.
- **Point/Leg required:** **Add AND Edit** hard-block an incomplete save (overrides the D8 partial-draft model for points/legs).
- **Defaults:** findings preview is **live** (client create-phase, recomputed as you build; server validate runs authoritatively on Save/Next). Hover appears on **both** the Point/Leg list cards **and** the diagram nodes/edges.

## Design
- **Layout (top→bottom):** Notices strip · Points · Legs · Route diagram (diagram moves to the bottom).
- **Notices strip:** summary ("⚠ N issue(s) to resolve — hover the highlighted boxes") + query-scoped findings that don't map to a single box (e.g. R5 "≥1 Pickup required", T2 first/last-leg-date rules).
- **Per-box findings:** each Point card, Leg card, and diagram node/edge shows a blocking (red) / warning state with a hover tooltip listing that block's message(s). Cargo-scoped chain findings fan onto the leg cards carrying that cargo. Existing click-to-cross-highlight kept.
- **Validate on Save/Next:** remove the *Validate route* button. Findings recompute live client-side at **create-phase**. **Next** runs the authoritative server create-validate and blocks advance if any blocking finding (top strip: "Resolve N issue(s) to continue"). **Save** runs it too but still persists.
- **Dialogs (#4):** `PointEditor` requires `POINT_REQUIRED_FIELDS[type]`; `LegEditor` requires origin, destination, mode, ≥1 assigned cargo, Ready Date, Target Delivery — before save, for both Add and Edit. (Self-loop + V-M1 already block via schema/server.)

## Components touched
`LegsStep` (reorder, strip, Next-gate via the step-save contract, hover on cards), `RouteDiagram` (hover tooltips), `useRouteFindings` (create-phase + grouped-by-box), `PointEditor` + `LegEditor` (mandatory checks). `FindingsPanel` list is no longer used at Step 4; the WizardShell Create-Query findings panel is untouched. Affected Point/Leg/LegsStep test fixtures are completed as part of the change.

## Implementation sequence (each TDD, RED→GREEN)
1. Point/Leg dialog mandatory-field validation.
2. `useRouteFindings` → create-phase + findings grouped by box scope.
3. LegsStep: reorder + top strip + hover on cards + remove Validate button.
4. RouteDiagram hover tooltips.
5. Step-4 Next-gate (Save persists + shows; Next blocks on any error).
6. Update affected tests throughout; `pnpm run ci` green.
