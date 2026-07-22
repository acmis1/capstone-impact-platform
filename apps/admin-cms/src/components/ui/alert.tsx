import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "../../lib/utils";

export const alertVariants = cva(
  "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground border-border",
        success: "bg-success/10 text-foreground border-success/30 [&>svg]:text-success",
        warning: "bg-warning/10 text-foreground border-warning/30 [&>svg]:text-warning",
        information: "bg-information/10 text-foreground border-information/30 [&>svg]:text-information",
        destructive: "bg-destructive/10 text-foreground border-destructive/30 [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

const variantIcons = {
  default: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  information: Info,
  destructive: AlertCircle,
};

export interface AlertProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof alertVariants> {
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
  description?: React.ReactNode;
}

export function Alert({
  className,
  variant = "default",
  icon: CustomIcon,
  title,
  description,
  children,
  role: callerRole,
  ref,
  ...props
}: AlertProps) {
  const Icon = CustomIcon || (variant ? variantIcons[variant] : Info);
  const defaultRole = variant === "destructive" ? "alert" : "status";
  const effectiveRole = callerRole ?? defaultRole;

  return (
    <div
      data-slot="alert"
      role={effectiveRole}
      ref={ref}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
      <div className="flex flex-col gap-1">
        {title && <div className="font-medium leading-none tracking-tight">{title}</div>}
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
        {children}
      </div>
    </div>
  );
}
