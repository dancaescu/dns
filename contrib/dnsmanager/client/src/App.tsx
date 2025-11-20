import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { LoginPage } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { CloudflareZonePage } from "./pages/CloudflareZonePage";
import { UserManagement } from "./pages/UserManagement";
import { Settings } from "./pages/Settings";
import { Tickets } from "./pages/Tickets";
import ApiDocs from "./pages/ApiDocs";
import { getToken, setToken, logout } from "./lib/api";

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

  useEffect(() => {
    if (!token) {
      setUser(null);
    }
  }, [token]);

  if (!token || !user) {
    return (
      <LoginPage
        onSuccess={(newToken, newUser) => {
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
      <Route path="/cloudflare/zones/:zoneId" element={<CloudflareZonePage onLogout={handleLogout} />} />
      <Route path="/api-docs" element={<ApiDocs />} />
      <Route path="/tickets" element={<Tickets onLogout={handleLogout} />} />
      {user?.role === "superadmin" && (
        <>
          <Route path="/users" element={<UserManagement onLogout={handleLogout} />} />
          <Route path="/settings" element={<Settings onLogout={handleLogout} />} />
        </>
      )}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
