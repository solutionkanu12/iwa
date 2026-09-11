import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OpenCeloCircle } from "./OpenCeloCircle";

describe("OpenCeloCircle", () => {
  it("renders an address entry point, since there is no backend listing for Celo circles", () => {
    const html = renderToStaticMarkup(<OpenCeloCircle navigate={vi.fn()} />);
    expect(html).toContain("Open a Celo circle");
    expect(html).toContain("Open");
  });
});
