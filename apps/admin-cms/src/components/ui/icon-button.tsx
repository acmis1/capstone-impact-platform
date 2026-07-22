import * as React from "react";
import { Button, type ButtonProps } from "./button";

export interface IconButtonProps extends Omit<ButtonProps, "size"> {
  "aria-label": string;
  size?: "default" | "sm" | "lg" | "icon";
}

export function IconButton({
  "aria-label": ariaLabel,
  size = "icon",
  children,
  ...props
}: IconButtonProps) {
  return (
    <Button
      data-slot="icon-button"
      size={size}
      aria-label={ariaLabel}
      {...props}
    >
      {children}
    </Button>
  );
}
