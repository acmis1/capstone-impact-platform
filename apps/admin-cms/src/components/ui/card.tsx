import * as React from "react";
import { cn } from "../../lib/utils";

export function Card({ className, ref, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      ref={ref}
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
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
      className={cn("flex flex-col space-y-1.5 p-4 sm:p-5", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ref, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-title"
      ref={ref}
      className={cn("text-base font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ref, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ref, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      ref={ref}
      className={cn("p-4 pt-0 sm:p-5 sm:pt-0", className)}
      {...props}
    />
  );
}

export function CardFooter({ className, ref, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      ref={ref}
      className={cn("flex items-center p-4 pt-0 sm:p-5 sm:pt-0", className)}
      {...props}
    />
  );
}
