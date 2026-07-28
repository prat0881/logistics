import type { Machine, Transition } from "@svyft/shared";
import { QuoteStatus, QuoteEvent } from "@svyft/shared";
import type { FireContext } from "../status/status.types";

export const quoteTransitions: Transition<QuoteStatus, QuoteEvent, FireContext>[] = [
  { from: QuoteStatus.SELECT, on: QuoteEvent.SEND, to: QuoteStatus.RFQ_SENT, kind: "forward" },
  { from: QuoteStatus.RFQ_SENT, on: QuoteEvent.SUBMIT, to: QuoteStatus.QUOTED, kind: "forward" },
  { from: QuoteStatus.RFQ_SENT, on: QuoteEvent.EXPIRE, to: QuoteStatus.EXPIRED, kind: "forward" },
  { from: QuoteStatus.QUOTED, on: QuoteEvent.INVALIDATE, to: QuoteStatus.INVALID, kind: "reopen" },
];

export const quoteMachine: Machine<QuoteStatus, QuoteEvent, FireContext> = {
  key: "quote",
  initial: QuoteStatus.SELECT,
  transitions: quoteTransitions,
};
