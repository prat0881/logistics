# Docs index

Source-of-truth specs and design notes, organized by delivery **Stage**. Each stage has a
**Functional Spec** (what/why, from the product side), a **Technical Design** (how, architecture
& decisions), zero or more **Sub-build / Round** designs (focused slices), and a **Session
Handoff** (rolling status: what's done, what's pending, key decisions, open questions).

> **Start here when picking up work:** read the relevant stage's **Session Handoff** first (it
> reflects current reality), then the **Technical Design** for the area you're touching.

## Cross-cutting

- **[../CLAUDE.md](../CLAUDE.md)** — commands, architecture map, build/test gotchas for this repo.
- **[../README.md](../README.md)** — local dev setup, env, auth, seed accounts.
- **Extensibility Core** (Status Machine + Change-Impact mediator) is described in the Stage-3 and
  Stage-4 Technical Design §7 — the framework every later stage plugs into. Read it before adding
  any status transition or query mutation.

## Stage 3 — Create Query

The query intake flow: client → cargo → points → legs → checklist, with derived query status.

- [Stage 3 - Create Query - Functional Spec.md](Stage%203%20-%20Create%20Query%20-%20Functional%20Spec.md)
- [Stage 3 - Technical Design.md](Stage%203%20-%20Technical%20Design.md)
- [Stage 3 - Req & Issues - Round 1 - Design.md](Stage%203%20-%20Req%20&%20Issues%20-%20Round%201%20-%20Design.md) · [Round 2](Stage%203%20-%20Req%20&%20Issues%20-%20Round%202%20-%20Design.md) · [Round 3](Stage%203%20-%20Req%20&%20Issues%20-%20Round%203%20-%20Design.md)
- [Stage 3 - Session Handoff.md](Stage%203%20-%20Session%20Handoff.md)

## Stage 4 — RFQ → Freight Forwarder → Quote

Sending RFQs to freight forwarders, the FF portal, quotes, charges, notifications, and change
cascades.

- [Stage 4 - RFQ Send to Freight Forwarder (v2) - Functional Spec.md](Stage%204%20-%20RFQ%20Send%20to%20Freight%20Forwarder%20(v2)%20-%20Functional%20Spec.md)
- [Stage 4 - Technical Design.md](Stage%204%20-%20Technical%20Design.md)
- Sub-builds: [SB5 — Notifications & Scheduler](Stage%204%20-%20Sub-build%205%20-%20Notifications%20&%20Scheduler%20-%20Design.md) · [SB6 — Change-Order Cascade](Stage%204%20-%20Sub-build%206%20-%20Change-Order%20Cascade%20-%20Design.md)
- [Stage 4 - Charge Configuration & Warehouse Attribution - Design.md](Stage%204%20-%20Charge%20Configuration%20&%20Warehouse%20Attribution%20-%20Design.md)
- [Stage 4 - Session Handoff.md](Stage%204%20-%20Session%20Handoff.md)

## Cross-stage

- [Stage 3 & 4 - UI-UX Improvements - Design.md](Stage%203%20&%204%20-%20UI-UX%20Improvements%20-%20Design.md)

## Working notes

- `plans/` — implementation plans (`stage-3/`, `stage-4/`).
- `superpowers/` — plans & specs authored via the Superpowers workflow.
