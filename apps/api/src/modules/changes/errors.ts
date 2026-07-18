export class ChangeOrderNotAvailableError extends Error {
  constructor() {
    super(
      "Change-order cascade is not available until Stage 4 (no downstream work exists in Stage 3)",
    );
    this.name = "ChangeOrderNotAvailableError";
  }
}
