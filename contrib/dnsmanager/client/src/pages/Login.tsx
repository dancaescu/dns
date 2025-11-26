import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { apiRequest } from "../lib/api";

interface Props {
  onSuccess: (token: string, user: { id: number; username: string; email: string; role: "superadmin" | "account_admin" | "user" }) => void;
}

interface LoginResponse {
  success?: boolean;
  requires2FA?: boolean;
  userId?: number;
  twofa_method?: string;
  message?: string;
  user?: {
    id: number;
    username: string;
    email: string;
    full_name?: string;
    role: "superadmin" | "account_admin" | "user";
  };
  sessionToken?: string;
}

export function LoginPage({ onSuccess }: Props) {
  const [step, setStep] = useState<"login" | "2fa">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [twoFACode, setTwoFACode] = useState("");
  const [userId, setUserId] = useState<number | null>(null);
  const [twoFAMethod, setTwoFAMethod] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await apiRequest<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });

      if (result.requires2FA) {
        // 2FA required
        setStep("2fa");
        setUserId(result.userId || null);
        setTwoFAMethod(result.twofa_method || "");
        setError(null);
      } else if (result.success && result.sessionToken && result.user) {
        // Login successful without 2FA
        onSuccess(result.sessionToken, result.user);
      } else {
        setError("Unexpected response from server");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify2FA = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userId) {
      setError("Invalid session");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const result = await apiRequest<LoginResponse>("/auth/verify-2fa", {
        method: "POST",
        body: JSON.stringify({ userId, code: twoFACode }),
      });

      if (result.success && result.sessionToken && result.user) {
        onSuccess(result.sessionToken, result.user);
      } else {
        setError("Unexpected response from server");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const handleBackToLogin = () => {
    setStep("login");
    setTwoFACode("");
    setUserId(null);
    setError(null);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>DNS Manager Login</CardTitle>
          {step === "2fa" && (
            <p className="text-sm text-muted-foreground">
              A verification code has been sent to your {twoFAMethod === "sms" ? "phone" : "email"}
            </p>
          )}
        </CardHeader>
        <CardContent>
          {step === "login" ? (
            <form className="space-y-4" onSubmit={handleLogin}>
              <div className="space-y-2">
                <Label htmlFor="username">Username or Email</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Signing in..." : "Sign In"}
              </Button>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={handleVerify2FA}>
              <div className="space-y-2">
                <Label htmlFor="2fa-code">Verification Code</Label>
                <Input
                  id="2fa-code"
                  value={twoFACode}
                  onChange={(e) => setTwoFACode(e.target.value)}
                  placeholder="Enter 6-digit code"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                />
              </div>
              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={handleBackToLogin} disabled={loading}>
                  Back
                </Button>
                <Button type="submit" className="flex-1" disabled={loading}>
                  {loading ? "Verifying..." : "Verify"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
