import { describe, expect, it } from "vitest";
import { computeReconnectDelay } from "./client";

describe("computeReconnectDelay", () => {
  it("starts at the base delay with deterministic jitter", () => {
    expect(computeReconnectDelay(0, () => 0.5)).toBe(1000);
  });

  it("applies the documented 0.8 to 1.2 jitter range", () => {
    expect(computeReconnectDelay(0, () => 0)).toBe(800);
    expect(computeReconnectDelay(0, () => 1)).toBe(1200);
  });

  it("grows exponentially and caps the retry attempt at five", () => {
    expect(computeReconnectDelay(1, () => 0.5)).toBe(2000);
    expect(computeReconnectDelay(5, () => 0.5)).toBe(30000);
    expect(computeReconnectDelay(99, () => 0.5)).toBe(30000);
  });

  it("treats negative attempts as the first retry attempt", () => {
    expect(computeReconnectDelay(-1, () => 0.5)).toBe(1000);
  });
});
