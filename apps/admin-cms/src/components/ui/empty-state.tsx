import * as React from "react";
import { FolderOpen } from "lucide-react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps extends React.ComponentProps<"div"> {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  headingLevel?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
}

export function EmptyState({
  className,
  icon: Icon = FolderOpen,
  title,
  description,
  action,
  headingLevel: Heading = "h3",
  ref,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      ref={ref}
      className={cn(
        "flex min-h-[240px] flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 text-center",
        className
      )}
      {...props}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </div>
      <Heading className="mt-4 text-base font-semibold text-foreground">{title}</Heading>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
