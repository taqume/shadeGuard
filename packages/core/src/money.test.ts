import { describe, expect, it } from "vitest";

import { formatZec, parseZec } from "./money.js";

describe("ZEC amount conversion", () => {
  it.each([
    ["0", 0],
    ["0.00000001", 1],
    ["0.01", 1_000_000],
    ["21", 2_100_000_000],
  ])("converts %s without floating-point arithmetic", (zec, zatoshi) => {
    expect(parseZec(zec)).toBe(zatoshi);
    expect(parseZec(formatZec(zatoshi))).toBe(zatoshi);
  });

  it.each(["-1", "1e-8", "0.000000001", "01.0", "NaN", "Infinity"])("rejects ambiguous amount %s", (value) => {
    expect(() => parseZec(value)).toThrow();
  });
});
