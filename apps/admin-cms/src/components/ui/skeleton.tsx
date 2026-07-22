import * as React from "react";
import { cn } from "../../lib/utils";

export function Skeleton({ className, ref, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      ref={ref}
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
