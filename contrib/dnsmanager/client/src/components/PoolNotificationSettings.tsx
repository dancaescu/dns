import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export interface PoolNotificationConfig {
  enabled: boolean;
  healthStatus: "healthy" | "unhealthy" | "either";
  emails: string[];
}

interface PoolNotificationSettingsProps {
  value: PoolNotificationConfig;
  onChange: (config: PoolNotificationConfig) => void;
  poolName?: string;
}

export function PoolNotificationSettings({
  value,
  onChange,
  poolName,
}: PoolNotificationSettingsProps) {
  const [emailInput, setEmailInput] = useState("");

  const addEmail = () => {
    const email = emailInput.trim();
    if (!email) return;

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert("Please enter a valid email address");
      return;
    }

    if (value.emails.includes(email)) {
      alert("This email is already in the list");
      return;
    }

    onChange({
      ...value,
      emails: [...value.emails, email],
    });
    setEmailInput("");
  };

  const removeEmail = (emailToRemove: string) => {
    onChange({
      ...value,
      emails: value.emails.filter((e) => e !== emailToRemove),
    });
  };

  return (
    <div className="space-y-4 rounded-lg border p-4 bg-gray-50">
      <div className="border-b pb-3">
        <h4 className="font-semibold text-gray-900">Pool Notifications</h4>
        <p className="text-sm text-gray-600 mt-1">
          Create alerts for Load Balancing to be notified when pools are enabled or disabled or
          when pools and endpoints have changes in their health.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h5 className="font-medium text-gray-900">Health Check Notifications</h5>
            <p className="text-xs text-gray-600">Manage pool health check notifications</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600"></div>
          </label>
        </div>

        {value.enabled && (
          <>
            <div className="mb-4">
              <Label className="text-sm font-medium text-gray-700 mb-2 block">Pool Status</Label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="health-status"
                    value="healthy"
                    checked={value.healthStatus === "healthy"}
                    onChange={(e) =>
                      onChange({ ...value, healthStatus: e.target.value as any })
                    }
                  />
                  <span>Healthy</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="health-status"
                    value="unhealthy"
                    checked={value.healthStatus === "unhealthy"}
                    onChange={(e) =>
                      onChange({ ...value, healthStatus: e.target.value as any })
                    }
                  />
                  <span>Unhealthy</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="health-status"
                    value="either"
                    checked={value.healthStatus === "either"}
                    onChange={(e) =>
                      onChange({ ...value, healthStatus: e.target.value as any })
                    }
                  />
                  <span>Either</span>
                </label>
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-gray-700 mb-2 block">
                Notification email address
              </Label>
              <div className="space-y-2 mb-3">
                {value.emails.map((email, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      value={email}
                      readOnly
                      className="flex-1 bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => removeEmail(email)}
                      className="text-blue-600 hover:text-blue-800 text-sm whitespace-nowrap"
                    >
                      Remove email address
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <Input
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addEmail();
                    }
                  }}
                  placeholder="email@example.com"
                  type="email"
                  className="flex-1"
                />
                <Button
                  type="button"
                  onClick={addEmail}
                  variant="outline"
                  size="sm"
                >
                  Add Email
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
