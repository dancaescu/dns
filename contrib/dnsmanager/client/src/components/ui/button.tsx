// THIS IS NOW A WRAPPER AROUND RADIX THEMES BUTTON
import { Button as RadixButton } from "@radix-ui/themes";
import type { ButtonProps as RadixButtonProps } from "@radix-ui/themes/dist/cjs/components/button.js";
import * as React from "react";

// Map our old button variants to Radix variants
function mapVariantToRadix(variant?: string): RadixButtonProps["variant"] {
  switch (variant) {
    case "destructive":
      return "soft";
    case "outline":
      return "outline";
    case "ghost":
      return "ghost";
    case "secondary":
      return "surface";
    case "success":
      return "solid";
    default:
      return "solid";
  }
}

function mapSizeToRadix(size?: string): RadixButtonProps["size"] {
  switch (size) {
    case "sm":
      return "1";
    case "lg":
      return "3";
    case "icon":
      return "2";
    default:
      return "2";
  }
}

export interface ButtonProps extends Omit<RadixButtonProps, "variant" | "size"> {
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "success";
  size?: "default" | "sm" | "lg" | "icon";
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant, size, asChild, color, ...props }, ref) => {
    // Map success variant to green color
    const radixColor = variant === "success" ? "green" : (variant === "destructive" ? "red" : color || "indigo");

    return (
      <RadixButton
        ref={ref}
        variant={mapVariantToRadix(variant)}
        size={mapSizeToRadix(size)}
        color={radixColor as any}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };
