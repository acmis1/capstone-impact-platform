import * as React from "react";
import { cn } from "../../lib/utils";

export interface InputProps extends React.ComponentProps<"input"> {
  isInvalid?: boolean;
}

export function Input({ className, type = "text", isInvalid = false, ref, ...props }: InputProps) {
  return (
    <input
      data-slot="input"
      ref={ref}
      type={type}
      aria-invalid={isInvalid || undefined}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        isInvalid && "border-destructive focus-visible:ring-destructive",
        className
      )}
      {...props}
    />
  );
}
