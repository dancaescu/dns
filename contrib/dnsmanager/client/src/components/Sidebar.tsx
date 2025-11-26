import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "./ui/button";
import {
  Home,
  Cloud,
  FileText,
  Key,
  Users,
  Settings as SettingsIcon,
  MapPin
} from "lucide-react";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

interface SidebarProps {
  user?: User | null;
}

export function Sidebar({ user }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const isSuperadmin = user?.role === "superadmin";
  const isAccountAdmin = user?.role === "account_admin";
  const isAdmin = isSuperadmin || isAccountAdmin;

  const isActive = (path: string) => location.pathname === path;

  const menuItems = [
    {
      label: "Dashboard",
      path: "/",
      icon: Home,
      show: true,
    },
    {
      label: "API Documentation",
      path: "/api-docs",
      icon: FileText,
      show: true,
    },
    {
      label: "API Tokens",
      path: "/api-tokens",
      icon: Key,
      show: true,
    },
    {
      label: "GeoIP Sensors",
      path: "/geosensors",
      icon: MapPin,
      show: true,
    },
    {
      label: "User Management",
      path: "/users",
      icon: Users,
      show: isAdmin,
    },
    {
      label: "System Settings",
      path: "/settings",
      icon: SettingsIcon,
      show: isSuperadmin,
    },
  ];

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 border-r border-border/50 bg-white/95 backdrop-blur-lg overflow-y-auto">
      <div className="flex flex-col h-full">
        {/* Logo/Brand */}
        <div className="p-6 border-b border-border/50">
          <h2 className="text-xl font-bold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
            DNS Manager
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            {user?.username || "User"}
          </p>
        </div>

        {/* Navigation Menu */}
        <nav className="flex-1 p-4">
          <div className="space-y-1">
            {menuItems.filter(item => item.show).map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);

              return (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                    active
                      ? "bg-primary/10 text-primary border border-primary/20"
                      : "text-gray-700 hover:bg-gray-100 border border-transparent"
                  }`}
                >
                  <Icon className={`h-5 w-5 ${active ? "text-primary" : "text-gray-500"}`} />
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </aside>
  );
}
