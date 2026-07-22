import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn utility", () => {
  it("handles conditional classes correctly", () => {
    const result = cn("base-class", true && "active-class", false && "inactive-class");
    expect(result).toBe("base-class active-class");
  });

  it("resolves conflicting Tailwind classes properly", () => {
    const result = cn("p-4", "p-6", "bg-red-500", "bg-blue-500");
    expect(result).toBe("p-6 bg-blue-500");
  });
});
