import * as React from "react";
import { cn } from "@/lib/utils";

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  isRequired?: boolean;
}

export function Label({ className, isRequired = false, children, ...props }: LabelProps) {
  return (
    <label
      data-slot="label"
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className
      )}
      {...props}
    >
      {children}
      {isRequired && <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>}
    </label>
  );
}
