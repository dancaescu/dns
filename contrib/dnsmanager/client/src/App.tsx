import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { LoginPage } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { CloudflareZonePage } from "./pages/CloudflareZonePage";
import { getToken, login, setToken } from "./lib/api";

interface User {
  id: number;
  username: string;
  role: string;
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
        loginFn={login}
        onSuccess={(newToken, newUser) => {
          setToken(newToken);
          setAuthToken(newToken);
          setUser(newUser);
        }}
      />
    );
  }

  const handleLogout = () => {
    setToken(null);
    setAuthToken(null);
    setUser(null);
  };

  return (
    <Routes>
      <Route path="/" element={<Dashboard onLogout={handleLogout} />} />
      <Route path="/cloudflare/zones/:zoneId" element={<CloudflareZonePage onLogout={handleLogout} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
