// THIS IS NOW A WRAPPER AROUND RADIX THEMES TEXT-FIELD
import { TextField } from "@radix-ui/themes";
import * as React from "react";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    // Filter out unsupported input types for Radix Themes
    const supportedTypes = ["text", "email", "password", "search", "tel", "url", "number", "date", "datetime-local", "month", "time", "week", "hidden"];
    const safeType = type && supportedTypes.includes(type) ? type as any : "text";

    return (
      <TextField.Root
        type={safeType}
        size="3"
        {...props as any}
        ref={ref}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
