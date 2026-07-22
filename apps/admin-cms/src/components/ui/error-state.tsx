import * as React from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "../../lib/utils";

export interface ErrorStateProps extends React.ComponentProps<"div"> {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  headingLevel?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
}

export function ErrorState({
  className,
  title = "An operational error occurred",
  description = "The requested information could not be processed. Please try again or contact system support.",
  action,
  headingLevel: Heading = "h3",
  ref,
  ...props
}: ErrorStateProps) {
  return (
    <div
      data-slot="error-state"
      ref={ref}
      role="alert"
      className={cn(
        "flex min-h-[240px] flex-col items-center justify-center rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center",
        className
      )}
      {...props}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle className="h-6 w-6" aria-hidden="true" />
      </div>
      <Heading className="mt-4 text-base font-semibold text-foreground">{title}</Heading>
      {description && (
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
