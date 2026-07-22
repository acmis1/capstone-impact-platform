import * as React from "react";
import { Button, type ButtonProps } from "./button";

export interface IconButtonProps extends Omit<Extract<ButtonProps, { asChild?: false }>, "size"> {
  "aria-label": string;
  size?: "default" | "sm" | "lg" | "icon";
}

export function IconButton({
  "aria-label": ariaLabel,
  size = "icon",
  children,
  ref,
  ...props
}: IconButtonProps) {
  if (!ariaLabel || ariaLabel.trim().length === 0) {
    throw new Error("IconButton requires a non-empty aria-label property.");
  }

  return (
    <Button
      data-slot="icon-button"
      size={size}
      aria-label={ariaLabel}
      ref={ref}
      {...props}
    >
      {children}
    </Button>
  );
}
