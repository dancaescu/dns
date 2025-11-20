import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { toast } from "./ui/toast";

export type LBPool = {
  id?: number;
  cf_pool_id?: string;
  name: string;
  description: string;
  enabled: boolean;
  minimum_origins: number;
  monitor: string;
  notification_email: string;
  health_check_regions: string[];
  origin_steering_policy: string;
  origins: LBOrigin[];
};

export type LBOrigin = {
  id?: number;
  name: string;
  address: string;
  enabled: boolean;
  weight: number;
  port?: number;
  header_host?: string;
};

interface LoadBalancerEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (lb: any) => Promise<void>;
  loadBalancer?: any;
  zoneName: string;
}

const STEERING_POLICIES = [
  { value: "random", label: "Random" },
  { value: "dynamic_latency", label: "Dynamic Latency" },
  { value: "geo", label: "Geo" },
  { value: "proximity", label: "Proximity" },
  { value: "least_outstanding_requests", label: "Least Outstanding Requests" },
  { value: "least_connections", label: "Least Connections" },
];

const MONITORS = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "tcp", label: "TCP" },
  { value: "udp_icmp", label: "UDP-ICMP" },
  { value: "icmp_ping", label: "ICMP Ping" },
  { value: "smtp", label: "SMTP" },
];

const HEALTH_CHECK_REGIONS = [
  "WNAM", "ENAM", "WEU", "EEU", "NSAM", "SSAM",
  "OC", "ME", "NAF", "SAF", "IN", "SEAS", "NEAS", "ALL"
];

export function LoadBalancerEditor({
  isOpen,
  onClose,
  onSave,
  loadBalancer,
  zoneName,
}: LoadBalancerEditorProps) {
  const [loading, setLoading] = useState(false);
  const [expandedPools, setExpandedPools] = useState<Set<number>>(new Set());

  const [form, setForm] = useState({
    name: loadBalancer?.name || "",
    proxied: loadBalancer?.proxied ?? true,
    enabled: loadBalancer?.enabled ?? true,
    ttl: loadBalancer?.ttl || 30,
    steering_policy: loadBalancer?.steering_policy || "random",
    session_affinity: loadBalancer?.session_affinity || "none",
    session_affinity_ttl: loadBalancer?.session_affinity_ttl || 82800,
    pools: (loadBalancer?.pools || []) as LBPool[],
  });

  if (!isOpen) return null;

  const addPool = () => {
    setForm({
      ...form,
      pools: [
        ...form.pools,
        {
          name: "",
          description: "",
          enabled: true,
          minimum_origins: 1,
          monitor: "http",
          notification_email: "",
          health_check_regions: ["WNAM"],
          origin_steering_policy: "random",
          origins: [],
        },
      ],
    });
  };

  const removePool = (poolIndex: number) => {
    setForm({
      ...form,
      pools: form.pools.filter((_, i) => i !== poolIndex),
    });
  };

  const updatePool = (poolIndex: number, updates: Partial<LBPool>) => {
    const newPools = [...form.pools];
    newPools[poolIndex] = { ...newPools[poolIndex], ...updates };
    setForm({ ...form, pools: newPools });
  };

  const addOrigin = (poolIndex: number) => {
    const newPools = [...form.pools];
    newPools[poolIndex].origins.push({
      name: "",
      address: "",
      enabled: true,
      weight: 1,
    });
    setForm({ ...form, pools: newPools });
  };

  const removeOrigin = (poolIndex: number, originIndex: number) => {
    const newPools = [...form.pools];
    newPools[poolIndex].origins = newPools[poolIndex].origins.filter((_, i) => i !== originIndex);
    setForm({ ...form, pools: newPools });
  };

  const updateOrigin = (poolIndex: number, originIndex: number, updates: Partial<LBOrigin>) => {
    const newPools = [...form.pools];
    newPools[poolIndex].origins[originIndex] = {
      ...newPools[poolIndex].origins[originIndex],
      ...updates,
    };
    setForm({ ...form, pools: newPools });
  };

  const togglePoolExpand = (poolIndex: number) => {
    const newExpanded = new Set(expandedPools);
    if (newExpanded.has(poolIndex)) {
      newExpanded.delete(poolIndex);
    } else {
      newExpanded.add(poolIndex);
    }
    setExpandedPools(newExpanded);
  };

  const calculatePercent = (weight: number, totalWeight: number) => {
    if (totalWeight === 0) return 0;
    return Math.round((weight / totalWeight) * 100);
  };

  const handleSave = async () => {
    if (!form.name) {
      toast.error("Load balancer name is required");
      return;
    }

    if (form.pools.length === 0) {
      toast.error("At least one pool is required");
      return;
    }

    for (const pool of form.pools) {
      if (!pool.name) {
        toast.error("All pools must have a name");
        return;
      }
      if (pool.origins.length === 0) {
        toast.error(`Pool "${pool.name}" must have at least one origin`);
        return;
      }
      for (const origin of pool.origins) {
        if (!origin.name || !origin.address) {
          toast.error(`All origins in pool "${pool.name}" must have name and address`);
          return;
        }
      }
    }

    setLoading(true);
    try {
      await onSave(form);
      onClose();
    } catch (error: any) {
      toast.error(error.message || "Failed to save load balancer");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 overflow-y-auto">
      <div className="w-full max-w-6xl max-h-[90vh] overflow-y-auto rounded-lg bg-white p-6 shadow-xl my-8">
        <h3 className="mb-4 text-xl font-semibold">
          {loadBalancer ? "Edit" : "Create"} Load Balancer: {zoneName}
        </h3>

        <div className="space-y-6">
          {/* Basic Settings */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="lb-name">Hostname</Label>
              <Input
                id="lb-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="api"
              />
            </div>
            <div>
              <Label htmlFor="lb-ttl">TTL (seconds)</Label>
              <Input
                id="lb-ttl"
                type="number"
                value={form.ttl}
                onChange={(e) => setForm({ ...form, ttl: parseInt(e.target.value) })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="lb-steering">Steering Policy</Label>
              <select
                id="lb-steering"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.steering_policy}
                onChange={(e) => setForm({ ...form, steering_policy: e.target.value })}
              >
                {STEERING_POLICIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-4 pt-6">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.proxied}
                  onChange={(e) => setForm({ ...form, proxied: e.target.checked })}
                />
                <span className="text-sm">Proxied</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                <span className="text-sm">Enabled</span>
              </label>
            </div>
          </div>

          {/* Pools */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold">Pools</h4>
              <Button onClick={addPool} size="sm">
                + Add Pool
              </Button>
            </div>

            {form.pools.map((pool, poolIndex) => {
              const totalWeight = pool.origins.reduce((sum, o) => sum + o.weight, 0);
              const isExpanded = expandedPools.has(poolIndex);

              return (
                <div key={poolIndex} className="mb-4 rounded-lg border p-4">
                  <div className="flex items-center justify-between mb-3">
                    <button
                      onClick={() => togglePoolExpand(poolIndex)}
                      className="flex items-center gap-2 text-left font-medium hover:text-blue-600"
                    >
                      <span>{isExpanded ? "▼" : "▶"}</span>
                      <span>{pool.name || `Pool ${poolIndex + 1}`}</span>
                      <span className="text-sm text-gray-500">
                        ({pool.origins.length} origins)
                      </span>
                    </button>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={pool.enabled}
                          onChange={(e) => updatePool(poolIndex, { enabled: e.target.checked })}
                        />
                        Enabled
                      </label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => removePool(poolIndex)}
                      >
                        Remove Pool
                      </Button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="space-y-4 mt-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Pool Name</Label>
                          <Input
                            value={pool.name}
                            onChange={(e) => updatePool(poolIndex, { name: e.target.value })}
                            placeholder="us-east-1"
                          />
                        </div>
                        <div>
                          <Label>Pool Description</Label>
                          <Input
                            value={pool.description}
                            onChange={(e) => updatePool(poolIndex, { description: e.target.value })}
                            placeholder="ex, US West Region"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <Label>Origin Steering</Label>
                          <select
                            className="w-full rounded-md border border-input px-3 py-2 text-sm"
                            value={pool.origin_steering_policy}
                            onChange={(e) =>
                              updatePool(poolIndex, { origin_steering_policy: e.target.value })
                            }
                          >
                            {STEERING_POLICIES.map((p) => (
                              <option key={p.value} value={p.value}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <Label>Monitor</Label>
                          <select
                            className="w-full rounded-md border border-input px-3 py-2 text-sm"
                            value={pool.monitor}
                            onChange={(e) => updatePool(poolIndex, { monitor: e.target.value })}
                          >
                            {MONITORS.map((m) => (
                              <option key={m.value} value={m.value}>
                                {m.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <Label>Health Threshold</Label>
                          <Input
                            type="number"
                            value={pool.minimum_origins}
                            onChange={(e) =>
                              updatePool(poolIndex, { minimum_origins: parseInt(e.target.value) })
                            }
                          />
                        </div>
                      </div>

                      <div>
                        <Label>Notification Email (comma-separated)</Label>
                        <Input
                          value={pool.notification_email}
                          onChange={(e) =>
                            updatePool(poolIndex, { notification_email: e.target.value })
                          }
                          placeholder="emergency@multitel.net, dan.caescu@multitel.net"
                        />
                      </div>

                      {/* Origins */}
                      <div className="border-t pt-3">
                        <div className="flex items-center justify-between mb-2">
                          <Label className="font-semibold">Endpoints</Label>
                          <Button
                            onClick={() => addOrigin(poolIndex)}
                            size="sm"
                            variant="outline"
                          >
                            + Add Endpoint
                          </Button>
                        </div>

                        {pool.origins.map((origin, originIndex) => (
                          <div key={originIndex} className="grid grid-cols-12 gap-2 mb-2 items-end">
                            <div className="col-span-3">
                              <Label className="text-xs">Endpoint Name</Label>
                              <Input
                                value={origin.name}
                                onChange={(e) =>
                                  updateOrigin(poolIndex, originIndex, { name: e.target.value })
                                }
                                placeholder="nyc3.multitel.net"
                                className="text-sm"
                              />
                            </div>
                            <div className="col-span-3">
                              <Label className="text-xs">Endpoint Address</Label>
                              <Input
                                value={origin.address}
                                onChange={(e) =>
                                  updateOrigin(poolIndex, originIndex, { address: e.target.value })
                                }
                                placeholder="nyc3.multitel.net"
                                className="text-sm"
                              />
                            </div>
                            <div className="col-span-1">
                              <Label className="text-xs">Port</Label>
                              <Input
                                type="number"
                                value={origin.port || ""}
                                onChange={(e) =>
                                  updateOrigin(poolIndex, originIndex, {
                                    port: e.target.value ? parseInt(e.target.value) : undefined,
                                  })
                                }
                                className="text-sm"
                              />
                            </div>
                            <div className="col-span-1">
                              <Label className="text-xs">Weight</Label>
                              <Input
                                type="number"
                                step="0.01"
                                value={origin.weight}
                                onChange={(e) =>
                                  updateOrigin(poolIndex, originIndex, {
                                    weight: parseFloat(e.target.value),
                                  })
                                }
                                className="text-sm"
                              />
                            </div>
                            <div className="col-span-1">
                              <Label className="text-xs">Percent</Label>
                              <div className="px-3 py-2 text-sm text-gray-600">
                                {calculatePercent(origin.weight, totalWeight)}%
                              </div>
                            </div>
                            <div className="col-span-1 flex items-center justify-center">
                              <label className="flex items-center gap-1">
                                <input
                                  type="checkbox"
                                  checked={origin.enabled}
                                  onChange={(e) =>
                                    updateOrigin(poolIndex, originIndex, {
                                      enabled: e.target.checked,
                                    })
                                  }
                                />
                                <span className="text-xs">On</span>
                              </label>
                            </div>
                            <div className="col-span-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => removeOrigin(poolIndex, originIndex)}
                                className="w-full text-xs"
                              >
                                Remove
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 border-t pt-4">
            <Button variant="outline" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={loading}>
              {loading ? "Saving..." : "Save Load Balancer"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
