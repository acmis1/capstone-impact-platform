import * as React from "react";
import { cn } from "../../lib/utils";

/** Shared outer geometry for major operational surfaces. */
export const OPERATIONAL_SURFACE_CLASS_NAME =
  "rounded-xl border border-border/80 bg-card shadow-xs";

/** Shared outer geometry for major operational regions only. */
export const STRUCTURAL_SURFACE_CLASS_NAME =
  "rounded-xl border border-border-structural bg-card shadow-xs";

export function Card({ className, ref, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      ref={ref}
      className={cn(
        `${OPERATIONAL_SURFACE_CLASS_NAME} text-card-foreground`,
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ref, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      ref={ref}
      className={cn("flex flex-col space-y-1.5 p-5 sm:p-6", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ref, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-title"
      ref={ref}
      className={cn("text-base font-semibold leading-tight tracking-tight text-foreground", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ref, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      ref={ref}
      className={cn("text-sm text-muted-foreground leading-relaxed", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ref, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      ref={ref}
      className={cn("p-5 pt-0 sm:p-6 sm:pt-0", className)}
      {...props}
    />
  );
}

export function CardFooter({ className, ref, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      ref={ref}
      className={cn("flex items-center p-5 pt-0 sm:p-6 sm:pt-0", className)}
      {...props}
    />
  );
}
