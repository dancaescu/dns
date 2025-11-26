import { Button } from "./ui/button";
import { useNavigate } from "react-router-dom";
import { Settings, LifeBuoy, LogOut } from "lucide-react";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

interface UnifiedHeaderProps {
  title?: string;
  subtitle?: string;
  onLogout: () => void;
  onSupportClick?: () => void;
  user?: User | null;
}

export function UnifiedHeader({ title, subtitle, onLogout, onSupportClick, user }: UnifiedHeaderProps) {
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-50 flex items-center justify-between border-b border-border/50 bg-white/80 backdrop-blur-lg px-8 py-4 elevation-2">
      {/* Page Title (optional, can be hidden if using breadcrumbs) */}
      {title && (
        <div>
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
      )}

      {/* Spacer when no title */}
      {!title && <div />}

      {/* User Actions */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate("/my-settings")} className="gap-2">
          <Settings className="h-4 w-4" />
          My Settings
        </Button>

        {onSupportClick && (
          <Button variant="ghost" size="sm" onClick={onSupportClick} className="gap-2">
            <LifeBuoy className="h-4 w-4" />
            Support
          </Button>
        )}

        <Button variant="ghost" size="sm" onClick={onLogout} className="gap-2">
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
      </div>
    </header>
  );
}
