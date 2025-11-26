// THIS IS NOW A WRAPPER AROUND RADIX THEMES CARD
import { Card as RadixCard, Heading, Text, Box } from "@radix-ui/themes";
import * as React from "react";

const Card = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof RadixCard>>(
  (props, ref) => (
    <RadixCard ref={ref} size="3" {...props} />
  ),
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ children, ...props }, ref) => (
    <Box ref={ref} p="4" style={{ borderBottom: "1px solid var(--gray-a5)" }} {...props}>
      {children}
    </Box>
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ children, ...props }, ref) => (
    <Heading as="h3" size="5" mb="1" {...props as any}>
      {children}
    </Heading>
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ children, ...props }, ref) => (
    <Text as="p" size="2" color="gray" {...props as any}>
      {children}
    </Text>
  ),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ children, ...props }, ref) => (
    <Box ref={ref} p="4" {...props}>
      {children}
    </Box>
  ),
);
CardContent.displayName = "CardContent";

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
