import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        neutral: "border-border/80 bg-muted/80 text-foreground font-medium",
        primary: "border-transparent bg-primary text-primary-foreground font-semibold shadow-2xs",
        success: "border-success/30 bg-success/10 text-success-strong font-medium",
        warning: "border-warning/30 bg-warning/10 text-warning-strong font-medium",
        information: "border-information/30 bg-information/10 text-information font-medium",
        destructive: "border-destructive/30 bg-destructive/10 text-destructive-strong font-medium",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  }
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ref, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      ref={ref}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}
