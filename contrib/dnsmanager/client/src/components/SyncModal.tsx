import { useState } from "react";
import { Button } from "./ui/button";
import { Label } from "./ui/label";

export type SyncMode = "pull-clean" | "pull-keep" | "pull-push";

interface SyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSync: (mode: SyncMode) => Promise<void>;
  zoneName: string;
  loading: boolean;
}

export function SyncModal({ isOpen, onClose, onSync, zoneName, loading }: SyncModalProps) {
  const [selectedMode, setSelectedMode] = useState<SyncMode>("pull-keep");

  if (!isOpen) return null;

  const handleSync = async () => {
    await onSync(selectedMode);
  };

  const syncOptions: Array<{ value: SyncMode; label: string; description: string; warning?: string }> = [
    {
      value: "pull-clean",
      label: "Pull & Clean",
      description: "Pulls all new and modified records from Cloudflare. Deletes local records not in Cloudflare.",
      warning: "⚠️ This will delete local records not found in Cloudflare",
    },
    {
      value: "pull-keep",
      label: "Pull & Keep",
      description: "Adds or updates records from Cloudflare. Keeps local records that do not exist in Cloudflare.",
    },
    {
      value: "pull-push",
      label: "Pull & Push",
      description: "Adds or updates records from Cloudflare. Pushes local-only records to Cloudflare.",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
        <h3 className="mb-4 text-xl font-semibold">Sync Zone: {zoneName}</h3>

        <p className="mb-6 text-sm text-gray-600">
          Choose how you want to synchronize DNS records between your local database and Cloudflare.
        </p>

        <div className="mb-6 space-y-3">
          {syncOptions.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer flex-col rounded-lg border-2 p-4 transition-colors ${
                selectedMode === option.value
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="sync-mode"
                  value={option.value}
                  checked={selectedMode === option.value}
                  onChange={(e) => setSelectedMode(e.target.value as SyncMode)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="font-semibold text-gray-900">{option.label}</div>
                  <div className="mt-1 text-sm text-gray-600">{option.description}</div>
                  {option.warning && selectedMode === option.value && (
                    <div className="mt-2 rounded bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
                      {option.warning}
                    </div>
                  )}
                </div>
              </div>
            </label>
          ))}
        </div>

        <div className="flex justify-end gap-3 border-t pt-4">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSync} disabled={loading}>
            {loading ? "Syncing..." : "Sync Now"}
          </Button>
        </div>
      </div>
    </div>
  );
}
