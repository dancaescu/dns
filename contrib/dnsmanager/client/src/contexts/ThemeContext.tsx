import React, { createContext, useContext, useEffect, useState } from "react";

export type ThemeMode = "classic" | "radix";

interface ThemeContextType {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    // Load theme from localStorage or default to classic
    const stored = localStorage.getItem("ui-theme");
    const initialTheme = (stored === "radix" || stored === "classic" ? stored : "classic") as ThemeMode;

    // Set data-theme immediately on mount
    document.documentElement.setAttribute("data-theme", initialTheme);

    return initialTheme;
  });

  useEffect(() => {
    // Save theme to localStorage
    localStorage.setItem("ui-theme", theme);

    // Update data attribute on root element for CSS targeting
    document.documentElement.setAttribute("data-theme", theme);

    console.log("Theme changed to:", theme);
  }, [theme]);

  const setTheme = (newTheme: ThemeMode) => {
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
