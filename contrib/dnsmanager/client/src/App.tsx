import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { LoginPage } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { CloudflareZonePage } from "./pages/CloudflareZonePage";
import { UserManagement } from "./pages/UserManagement";
import { Settings } from "./pages/Settings";
import ApiDocs from "./pages/ApiDocs";
import { ApiTokensPage } from "./pages/ApiTokensPage";
import { UserSettings } from "./pages/UserSettings";
import { getToken, setToken, logout, apiRequest, onTokenChange } from "./lib/api";

interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  full_name?: string;
}

export default function App() {
  const [token, setAuthToken] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<User | null>(null);
  const [isValidating, setIsValidating] = useState<boolean>(false);

  // Listen for token changes from api.ts (e.g., when 401 clears the token)
  useEffect(() => {
    onTokenChange((newToken) => {
      setAuthToken(newToken);
    });
  }, []);

  // Validate token on mount only (not on every token change)
  useEffect(() => {
    const initialToken = getToken();
    console.log("[App] Mount validation check:", { initialToken: !!initialToken, user: !!user, isValidating });
    if (initialToken && !user && !isValidating) {
      console.log("[App] Starting token validation for token:", initialToken.substring(0, 10) + "...");
      setIsValidating(true);
      const tokenBeingValidated = initialToken;
      apiRequest<{ user: User }>("/auth/me")
        .then((response) => {
          console.log("[App] Token validation succeeded:", response.user.username);
          // Only set user if token hasn't changed since validation started
          if (getToken() === tokenBeingValidated) {
            setUser(response.user);
          } else {
            console.log("[App] Token changed during validation, ignoring result");
          }
        })
        .catch((error) => {
          console.error("[App] Token validation failed:", error.message);
          // Only clear if the token being validated is still the current token
          if (getToken() === tokenBeingValidated) {
            console.log("[App] Clearing invalid token");
            setToken(null);
            setAuthToken(null);
            setUser(null);
          } else {
            console.log("[App] Token changed during validation, not clearing");
          }
        })
        .finally(() => {
          setIsValidating(false);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  // Clear user when token is removed
  useEffect(() => {
    console.log("[App] Token changed:", { token: token ? token.substring(0, 10) + "..." : null, user: user?.username });
    if (!token) {
      setUser(null);
    }
  }, [token, user]);

  if (!token || !user) {
    return (
      <LoginPage
        onSuccess={(newToken, newUser) => {
          console.log("[App] Login success, setting token and user:", newUser.username);
          setToken(newToken);
          setAuthToken(newToken);
          setUser(newUser);
        }}
      />
    );
  }

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error("Logout error:", error);
    }
    setToken(null);
    setAuthToken(null);
    setUser(null);
  };

  return (
    <Routes>
      <Route path="/" element={<Dashboard onLogout={handleLogout} user={user} />} />
      <Route path="/cloudflare/zones/:zoneId" element={<CloudflareZonePage onLogout={handleLogout} user={user} />} />
      <Route path="/api-docs" element={<ApiDocs onLogout={handleLogout} user={user} />} />
      <Route path="/api-tokens" element={<ApiTokensPage onLogout={handleLogout} user={user} />} />
      <Route path="/my-settings" element={<UserSettings user={user} onLogout={handleLogout} />} />
      {user?.role === "superadmin" && (
        <>
          <Route path="/users" element={<UserManagement onLogout={handleLogout} user={user} />} />
          <Route path="/settings" element={<Settings onLogout={handleLogout} user={user} />} />
        </>
      )}
      {user?.role === "account_admin" && (
        <Route path="/users" element={<UserManagement onLogout={handleLogout} user={user} />} />
      )}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
