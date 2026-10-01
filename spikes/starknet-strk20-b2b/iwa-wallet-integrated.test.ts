/*
 * B2-B-R2 starts as a CI-only red test. The complete implementation is added
 * after this first run proves that the disposable workflow is actually
 * executing the composite harness rather than merely its component suites.
 */
import { describe, it } from "vitest";

describe("Iwa B2-B-R2 integrated vault and STRK20 proof", () => {
  it("does not yet have a composite proof harness", () => {
    throw new Error("B2BR2_COMPOSITE_HARNESS_NOT_IMPLEMENTED");
  });
});
