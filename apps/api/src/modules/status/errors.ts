import type { Finding } from "@svyft/shared";

export class IllegalTransitionError extends Error {
  constructor(
    public readonly key: string,
    public readonly from: string,
    public readonly event: string,
  ) {
    super(`No '${event}' transition from '${from}' on machine '${key}'`);
    this.name = "IllegalTransitionError";
  }
}

export class TransitionBlockedError extends Error {
  constructor(public readonly findings: Finding[]) {
    super(`Transition blocked by ${findings.length} finding(s)`);
    this.name = "TransitionBlockedError";
  }
}
