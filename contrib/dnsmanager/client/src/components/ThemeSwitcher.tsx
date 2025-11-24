import * as React from "react";
import * as Switch from "@radix-ui/react-switch";
import { useTheme } from "../contexts/ThemeContext";
import { Palette } from "lucide-react";

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const isRadix = theme === "radix";

  const handleChange = (checked: boolean) => {
    const newTheme = checked ? "radix" : "classic";
    console.log("Switching theme to:", newTheme);
    setTheme(newTheme);
  };

  return (
    <div className="flex items-center gap-2">
      <Palette className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">Classic</span>
      <Switch.Root
        checked={isRadix}
        onCheckedChange={handleChange}
        className="relative h-6 w-11 cursor-pointer rounded-full bg-secondary outline-none transition-colors data-[state=checked]:bg-primary"
      >
        <Switch.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow-md transition-transform duration-100 will-change-transform data-[state=checked]:translate-x-[22px]" />
      </Switch.Root>
      <span className="text-sm text-muted-foreground">Radix</span>
    </div>
  );
}
