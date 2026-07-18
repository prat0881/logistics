import type { Machine, Transition } from "@svyft/shared";
import { LegEvent, LegStatus } from "@svyft/shared";
import type { FireContext } from "./status.types";

// Stage-3 leg slice (§7.2, §9.2). Full state vocabulary is declared in
// `@svyft/shared`; only these two edges are active now:
//   DRAFT --validate.pass [guard: route valid]--> READY_FOR_RFQ   (forward)
//   READY_FOR_RFQ --reopen--> DRAFT                                (reopen; the seam)
// The forward guard consumes ctx.routeValid (Plan 5 supplies it from validateRoute);
// when false it blocks with ctx.findings (or a default blocking finding).
export const legTransitions: Transition<LegStatus, LegEvent, FireContext>[] = [
  {
    from: LegStatus.DRAFT,
    on: LegEvent.VALIDATE_PASS,
    to: LegStatus.READY_FOR_RFQ,
    kind: "forward",
    guard: (ctx) =>
      ctx.routeValid === true
        ? true
        : (ctx.findings ?? [
            {
              rule: "C1",
              severity: "blocking",
              scope: { type: "leg" },
              message: "Leg is incomplete or its route is not valid",
            },
          ]),
  },
  {
    from: LegStatus.READY_FOR_RFQ,
    on: LegEvent.REOPEN,
    to: LegStatus.DRAFT,
    kind: "reopen",
  },
];

export const legMachine: Machine<LegStatus, LegEvent, FireContext> = {
  key: "leg",
  initial: LegStatus.DRAFT,
  transitions: legTransitions,
};
