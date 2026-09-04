import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground hover:shadow-md shadow-xs font-semibold active:translate-y-px",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/90 shadow-xs font-semibold",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-2xs font-medium",
        ghost: "hover:bg-accent hover:text-accent-foreground font-medium",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-xs font-semibold",
        link: "text-primary underline-offset-4 hover:underline font-medium",
      },
      size: {
        default: "h-10 px-4 py-2 min-h-[40px]",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-11 rounded-md px-8 text-base font-semibold",
        icon: "h-10 w-10 min-h-[40px] min-w-[40px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

type BaseButtonProps = Omit<React.ComponentProps<"button">, "disabled"> &
  VariantProps<typeof buttonVariants>;

export type ButtonProps =
  | (BaseButtonProps & {
      asChild?: false;
      isLoading?: boolean;
      disabled?: boolean;
    })
  | (BaseButtonProps & {
      asChild: true;
      isLoading?: never;
      disabled?: never;
    });

export function Button({
  className,
  variant,
  size,
  asChild = false,
  isLoading = false,
  disabled,
  children,
  type,
  ref,
  ...props
}: ButtonProps) {
  if (asChild) {
    return (
      <Slot.Root
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref as React.Ref<HTMLElement>}
        {...props}
      >
        {children}
      </Slot.Root>
    );
  }

  const isButtonDisabled = Boolean(disabled || isLoading);

  return (
    <button
      data-slot="button"
      ref={ref}
      type={type ?? "button"}
      disabled={isButtonDisabled}
      aria-busy={isLoading ? true : undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {isLoading && <Loader2 className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
