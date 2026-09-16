import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { masterErrorMessage } from "./masterErrorMessage";

describe("masterErrorMessage", () => {
  it("prefers the first usable issue message on an ApiError with issues", () => {
    const err = new ApiError(400, "Validation failed", undefined, [
      { path: ["contacts"], message: "Exactly one contact must be marked Primary" },
      { path: ["city"], message: "Required" },
    ]);
    expect(masterErrorMessage(err, "Could not save this client")).toBe(
      "Exactly one contact must be marked Primary",
    );
  });

  it("falls through past an issue whose message is blank or missing to the next usable one", () => {
    const blankFirst = new ApiError(400, "Validation failed", undefined, [
      { path: ["contacts"], message: "   " },
      { path: ["city"], message: "Required" },
    ]);
    expect(masterErrorMessage(blankFirst, "fallback")).toBe("Required");

    const missingFirst = new ApiError(400, "Validation failed", undefined, [
      { path: ["contacts"] },
      { path: ["city"], message: "Required" },
    ]);
    expect(masterErrorMessage(missingFirst, "fallback")).toBe("Required");
  });

  it("uses err.message when the ApiError has no issues", () => {
    const err = new ApiError(409, "This client already has a primary contact");
    expect(masterErrorMessage(err, "fallback")).toBe("This client already has a primary contact");
  });

  it("uses the fallback when the ApiError's message is blank and there are no issues", () => {
    const err = new ApiError(500, "   ");
    expect(masterErrorMessage(err, "Could not save this client")).toBe("Could not save this client");
  });

  it("uses the fallback when the ApiError's message is blank and issues carry no usable message", () => {
    const err = new ApiError(400, "   ", undefined, [{ path: ["city"] }]);
    expect(masterErrorMessage(err, "Could not save this client")).toBe("Could not save this client");
  });

  it("uses the fallback for a non-ApiError value", () => {
    expect(masterErrorMessage(new Error("network down"), "Could not save this client")).toBe(
      "Could not save this client",
    );
    expect(masterErrorMessage("some string", "Could not save this client")).toBe(
      "Could not save this client",
    );
    expect(masterErrorMessage(undefined, "Could not save this client")).toBe(
      "Could not save this client",
    );
  });
});
