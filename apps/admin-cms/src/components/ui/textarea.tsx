import * as React from "react";
import { cn } from "../../lib/utils";

export interface TextareaProps extends React.ComponentProps<"textarea"> {
  isInvalid?: boolean;
}

export function Textarea({ className, isInvalid = false, ref, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      ref={ref}
      aria-invalid={isInvalid || undefined}
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        isInvalid && "border-destructive focus-visible:ring-destructive",
        className
      )}
      {...props}
    />
  );
}
