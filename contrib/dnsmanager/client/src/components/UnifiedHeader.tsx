import { Button } from "./ui/button";
import { useNavigate } from "react-router-dom";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

interface UnifiedHeaderProps {
  title: string;
  subtitle?: string;
  showBackButton?: boolean;
  onLogout: () => void;
  onSupportClick?: () => void;
  user?: User | null;
}

export function UnifiedHeader({ title, subtitle, showBackButton = false, onLogout, onSupportClick, user }: UnifiedHeaderProps) {
  const navigate = useNavigate();

  const isSuperadmin = user?.role === "superadmin";
  const isAccountAdmin = user?.role === "account_admin";
  const isAdmin = isSuperadmin || isAccountAdmin;

  return (
    <header className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b border-border/50 bg-white/80 backdrop-blur-lg px-8 py-5 elevation-2">
      <div className="flex items-center gap-4">
        {showBackButton && (
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            Back
          </Button>
        )}
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate("/")}>
          Dashboard
        </Button>

        <Button variant="outline" size="sm" onClick={() => navigate("/api-docs")}>
          API Docs
        </Button>

        <Button variant="outline" size="sm" onClick={() => navigate("/api-tokens")}>
          API Tokens
        </Button>

        <Button variant="outline" size="sm" onClick={() => navigate("/my-settings")}>
          My Settings
        </Button>

        {onSupportClick && (
          <Button variant="outline" size="sm" onClick={onSupportClick}>
            Support
          </Button>
        )}

        {isAdmin && (
          <Button variant="outline" size="sm" onClick={() => navigate("/users")}>
            Users
          </Button>
        )}

        {isSuperadmin && (
          <Button variant="outline" size="sm" onClick={() => navigate("/settings")}>
            Settings
          </Button>
        )}

        <Button variant="ghost" size="sm" onClick={onLogout}>
          Logout
        </Button>
      </div>
    </header>
  );
}
