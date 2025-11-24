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
    <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-6 py-4">
      <div className="flex items-center gap-3">
        {showBackButton && (
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            Back
          </Button>
        )}
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
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
