// THIS IS NOW A WRAPPER AROUND RADIX THEMES TEXT-FIELD
import { TextField } from "@radix-ui/themes";
import * as React from "react";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <TextField.Root
      type={type}
      size="3"
      {...props}
      ref={ref}
    />
  ),
);
Input.displayName = "Input";

export { Input };
