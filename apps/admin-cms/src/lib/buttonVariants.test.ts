import { describe, expect, it } from "vitest";
import { buttonVariants } from "../components/ui/button";

describe("buttonVariants", () => {
  it("returns default classes when no options are passed", () => {
    const classes = buttonVariants();
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("text-primary-foreground");
    expect(classes).toContain("h-9");
  });

  it("applies secondary variant classes correctly", () => {
    const classes = buttonVariants({ variant: "secondary" });
    expect(classes).toContain("bg-secondary");
    expect(classes).toContain("text-secondary-foreground");
  });

  it("applies destructive variant classes correctly", () => {
    const classes = buttonVariants({ variant: "destructive" });
    expect(classes).toContain("bg-destructive");
    expect(classes).toContain("text-destructive-foreground");
  });

  it("handles size selection correctly", () => {
    const smClasses = buttonVariants({ size: "sm" });
    expect(smClasses).toContain("h-8");
    expect(smClasses).toContain("px-3");

    const lgClasses = buttonVariants({ size: "lg" });
    expect(lgClasses).toContain("h-10");
    expect(lgClasses).toContain("px-8");

    const iconClasses = buttonVariants({ size: "icon" });
    expect(iconClasses).toContain("h-9");
    expect(iconClasses).toContain("w-9");
  });

  it("merges custom caller classes", () => {
    const classes = buttonVariants({ className: "custom-class m-2" });
    expect(classes).toContain("custom-class");
    expect(classes).toContain("m-2");
  });
});
