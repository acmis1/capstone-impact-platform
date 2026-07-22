import * as React from "react";
import { cn } from "../../lib/utils";

export interface LabelProps extends React.ComponentProps<"label"> {
  isRequired?: boolean;
}

export function Label({ className, isRequired = false, children, ref, ...props }: LabelProps) {
  return (
    <label
      data-slot="label"
      ref={ref}
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className
      )}
      {...props}
    >
      {children}
      {isRequired && (
        <>
          <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </label>
  );
}
