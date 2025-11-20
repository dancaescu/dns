import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { apiRequest } from "../lib/api";
import { useNavigate } from "react-router-dom";

interface Setting {
  id: number;
  setting_key: string;
  setting_value: string;
  is_encrypted: number;
  description: string | null;
  updated_at: string;
}

export function Settings({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Setting[]>([]);
  const [multitelApiUser, setMultitelApiUser] = useState("");
  const [multitelApiPass, setMultitelApiPass] = useState("");
  const [multitelApiUrl, setMultitelApiUrl] = useState("");
  const [sessionTimeout, setSessionTimeout] = useState("");
  const [require2FAAll, setRequire2FAAll] = useState(false);
  const [ticketAdminEmail, setTicketAdminEmail] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpFromEmail, setSmtpFromEmail] = useState("");
  const [smtpFromName, setSmtpFromName] = useState("DNS Manager");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const response = await apiRequest<{ settings: Setting[] }>("/settings");
      setSettings(response.settings);

      // Populate form with existing settings
      response.settings.forEach((setting) => {
        switch (setting.setting_key) {
          case "multitel_api_user":
            setMultitelApiUser(setting.setting_value);
            break;
          case "multitel_api_pass":
            setMultitelApiPass(setting.setting_value);
            break;
          case "multitel_api_url":
            setMultitelApiUrl(setting.setting_value);
            break;
          case "session_timeout":
            setSessionTimeout(setting.setting_value);
            break;
          case "require_2fa_all":
            setRequire2FAAll(setting.setting_value === "1");
            break;
          case "ticket_admin_email":
            setTicketAdminEmail(setting.setting_value);
            break;
          case "smtp_host":
            setSmtpHost(setting.setting_value);
            break;
          case "smtp_port":
            setSmtpPort(setting.setting_value);
            break;
          case "smtp_user":
            setSmtpUser(setting.setting_value);
            break;
          case "smtp_pass":
            setSmtpPass(setting.setting_value);
            break;
          case "smtp_from_email":
            setSmtpFromEmail(setting.setting_value);
            break;
          case "smtp_from_name":
            setSmtpFromName(setting.setting_value);
            break;
        }
      });
    } catch (error) {
      console.error("Failed to load settings:", error);
      alert("Failed to load settings");
    }
  }

  async function updateSetting(key: string, value: string) {
    try {
      await apiRequest(`/settings/${key}`, {
        method: "PUT",
        body: JSON.stringify({ setting_value: value }),
      });
    } catch (error) {
      console.error(`Failed to update ${key}:`, error);
      throw error;
    }
  }

  async function handleSaveSettings() {
    setLoading(true);
    try {
      await Promise.all([
        updateSetting("multitel_api_user", multitelApiUser),
        updateSetting("multitel_api_pass", multitelApiPass),
        updateSetting("multitel_api_url", multitelApiUrl),
        updateSetting("session_timeout", sessionTimeout),
        updateSetting("require_2fa_all", require2FAAll ? "1" : "0"),
        updateSetting("ticket_admin_email", ticketAdminEmail),
        updateSetting("smtp_host", smtpHost),
        updateSetting("smtp_port", smtpPort),
        updateSetting("smtp_user", smtpUser),
        updateSetting("smtp_pass", smtpPass),
        updateSetting("smtp_from_email", smtpFromEmail),
        updateSetting("smtp_from_name", smtpFromName),
      ]);
      alert("Settings saved successfully!");
      loadSettings();
    } catch (error) {
      console.error("Failed to save settings:", error);
      alert("Failed to save some settings. Check console for details.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">System Settings</h1>
          <p className="text-sm text-muted-foreground">Configure system-wide settings</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => navigate("/")}>
            Back to Dashboard
          </Button>
          <Button variant="outline" onClick={onLogout}>
            Logout
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle>Multitel API Configuration</CardTitle>
            <p className="text-sm text-muted-foreground">
              Configure Multitel API credentials for SMS and email 2FA
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="multitel-api-user">API Username</Label>
              <Input
                id="multitel-api-user"
                value={multitelApiUser}
                onChange={(e) => setMultitelApiUser(e.target.value)}
                placeholder="Enter Multitel API username"
              />
            </div>
            <div>
              <Label htmlFor="multitel-api-pass">API Password</Label>
              <Input
                id="multitel-api-pass"
                type="password"
                value={multitelApiPass}
                onChange={(e) => setMultitelApiPass(e.target.value)}
                placeholder="Enter Multitel API password"
              />
            </div>
            <div>
              <Label htmlFor="multitel-api-url">API URL</Label>
              <Input
                id="multitel-api-url"
                value={multitelApiUrl}
                onChange={(e) => setMultitelApiUrl(e.target.value)}
                placeholder="https://api.multitel.net/v3/sendcode"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Default: https://api.multitel.net/v3/sendcode
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Security Settings</CardTitle>
            <p className="text-sm text-muted-foreground">Configure authentication and security options</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="session-timeout">Session Timeout (seconds)</Label>
              <Input
                id="session-timeout"
                type="number"
                value={sessionTimeout}
                onChange={(e) => setSessionTimeout(e.target.value)}
                placeholder="3600"
              />
              <p className="mt-1 text-xs text-muted-foreground">Default: 3600 (1 hour)</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="require-2fa-all"
                checked={require2FAAll}
                onChange={(e) => setRequire2FAAll(e.target.checked)}
                className="rounded"
              />
              <Label htmlFor="require-2fa-all" className="cursor-pointer">
                Require 2FA for all users
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              When enabled, all users will be required to set up 2FA on their next login
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Email Configuration</CardTitle>
            <p className="text-sm text-muted-foreground">Configure SMTP settings for ticket notifications</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="ticket-admin-email">Ticket Admin Email</Label>
              <Input
                id="ticket-admin-email"
                type="email"
                value={ticketAdminEmail}
                onChange={(e) => setTicketAdminEmail(e.target.value)}
                placeholder="admin@example.com"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Email address to receive support ticket notifications
              </p>
            </div>
            <div>
              <Label htmlFor="smtp-host">SMTP Host</Label>
              <Input
                id="smtp-host"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
              />
            </div>
            <div>
              <Label htmlFor="smtp-port">SMTP Port</Label>
              <Input
                id="smtp-port"
                type="number"
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                placeholder="587"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Common ports: 587 (TLS), 465 (SSL), 25 (plain)
              </p>
            </div>
            <div>
              <Label htmlFor="smtp-user">SMTP Username</Label>
              <Input
                id="smtp-user"
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.target.value)}
                placeholder="Enter SMTP username"
              />
            </div>
            <div>
              <Label htmlFor="smtp-pass">SMTP Password</Label>
              <Input
                id="smtp-pass"
                type="password"
                value={smtpPass}
                onChange={(e) => setSmtpPass(e.target.value)}
                placeholder="Enter SMTP password"
              />
            </div>
            <div>
              <Label htmlFor="smtp-from-email">From Email Address</Label>
              <Input
                id="smtp-from-email"
                type="email"
                value={smtpFromEmail}
                onChange={(e) => setSmtpFromEmail(e.target.value)}
                placeholder="noreply@example.com"
              />
            </div>
            <div>
              <Label htmlFor="smtp-from-name">From Name</Label>
              <Input
                id="smtp-from-name"
                value={smtpFromName}
                onChange={(e) => setSmtpFromName(e.target.value)}
                placeholder="DNS Manager"
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSaveSettings} disabled={loading}>
            {loading ? "Saving..." : "Save Settings"}
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Settings</CardTitle>
            <p className="text-sm text-muted-foreground">View all system settings</p>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {settings.map((setting) => (
                <div
                  key={setting.id}
                  className="flex items-center justify-between rounded border p-3"
                >
                  <div>
                    <p className="font-medium">{setting.setting_key}</p>
                    {setting.description && (
                      <p className="text-sm text-muted-foreground">{setting.description}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm">
                      {setting.is_encrypted ? "••••••••" : setting.setting_value || "(empty)"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Updated: {new Date(setting.updated_at).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
