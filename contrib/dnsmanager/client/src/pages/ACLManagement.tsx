import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select } from "../components/ui/select";
import { apiRequest } from "../lib/api";
import { Layout } from "../components/Layout";
import { Trash2, Plus, Edit2, Save, X, Shield, Database } from "lucide-react";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

interface ACLRule {
  id: number;
  target: string;
  type: string;
  value: string;
  action: string;
  description: string | null;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface CacheConfig {
  id?: number;
  enabled: boolean;
  cache_size_mb: number;
  cache_ttl_min: number;
  cache_ttl_max: number;
  upstream_servers: string;
}

export function ACLManagement({ onLogout, user }: { onLogout: () => void; user: User | null }) {
  const [rules, setRules] = useState<ACLRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"acl" | "cache">("acl");

  // ACL Form State
  const [formData, setFormData] = useState({
    target: "system",
    type: "ip",
    value: "",
    action: "deny",
    description: "",
    priority: "100",
    enabled: true,
  });

  // Cache Config State
  const [cacheConfig, setCacheConfig] = useState<CacheConfig>({
    enabled: true,
    cache_size_mb: 256,
    cache_ttl_min: 60,
    cache_ttl_max: 86400,
    upstream_servers: "8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1",
  });

  useEffect(() => {
    loadRules();
    loadCacheConfig();
  }, []);

  async function loadRules() {
    try {
      setLoading(true);
      const response = await apiRequest<{ rules: ACLRule[] }>("/acl");
      setRules(response.rules);
    } catch (error) {
      console.error("Error loading ACL rules:", error);
      alert("Failed to load ACL rules");
    } finally {
      setLoading(false);
    }
  }

  async function loadCacheConfig() {
    try {
      const response = await apiRequest<{ config: CacheConfig }>("/acl/cache-config");
      setCacheConfig(response.config);
    } catch (error) {
      console.error("Error loading cache config:", error);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      setLoading(true);

      const payload = {
        ...formData,
        priority: parseInt(formData.priority),
      };

      if (editingId) {
        await apiRequest(`/acl/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        alert("ACL rule updated successfully");
      } else {
        await apiRequest("/acl", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        alert("ACL rule created successfully");
      }

      resetForm();
      await loadRules();
    } catch (error: any) {
      alert(error.message || "Failed to save ACL rule");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Are you sure you want to delete this ACL rule?")) return;

    try {
      await apiRequest(`/acl/${id}`, { method: "DELETE" });
      alert("ACL rule deleted successfully");
      await loadRules();
    } catch (error) {
      alert("Failed to delete ACL rule");
    }
  }

  function handleEdit(rule: ACLRule) {
    setFormData({
      target: rule.target,
      type: rule.type,
      value: rule.value,
      action: rule.action,
      description: rule.description || "",
      priority: rule.priority.toString(),
      enabled: rule.enabled,
    });
    setEditingId(rule.id);
    setShowAddForm(true);
  }

  function resetForm() {
    setFormData({
      target: "system",
      type: "ip",
      value: "",
      action: "deny",
      description: "",
      priority: "100",
      enabled: true,
    });
    setEditingId(null);
    setShowAddForm(false);
  }

  async function handleSaveCacheConfig(e: React.FormEvent) {
    e.preventDefault();
    try {
      setLoading(true);
      await apiRequest("/acl/cache-config", {
        method: "PUT",
        body: JSON.stringify(cacheConfig),
      });
      alert("Cache configuration updated successfully. Restart MyDNS to apply changes.");
    } catch (error: any) {
      alert(error.message || "Failed to update cache configuration");
    } finally {
      setLoading(false);
    }
  }

  const targetLabels: Record<string, string> = {
    system: "System-wide",
    master: "Master Zones",
    slave: "Slave Zones",
    cache: "DNS Caching",
    webui: "Web UI",
    doh: "DNS over HTTPS",
  };

  const typeLabels: Record<string, string> = {
    ip: "IP Address",
    network: "Network (CIDR)",
    country: "Country Code",
    asn: "ASN",
  };

  return (
    <Layout onLogout={onLogout} user={user}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Access Control & DNS Cache</h2>
            <p className="text-muted-foreground">
              Manage IP-based access control rules and DNS caching configuration
            </p>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex space-x-2 border-b">
          <button
            onClick={() => setActiveTab("acl")}
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              activeTab === "acl"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            <Shield className="inline-block mr-2 h-4 w-4" />
            Access Control Rules
          </button>
          <button
            onClick={() => setActiveTab("cache")}
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              activeTab === "cache"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            <Database className="inline-block mr-2 h-4 w-4" />
            DNS Cache Configuration
          </button>
        </div>

        {/* ACL Rules Tab */}
        {activeTab === "acl" && (
          <>
            <div className="flex justify-between items-center">
              <Button
                onClick={() => setShowAddForm(!showAddForm)}
                variant={showAddForm ? "outline" : "default"}
              >
                {showAddForm ? (
                  <>
                    <X className="mr-2 h-4 w-4" />
                    Cancel
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    Add ACL Rule
                  </>
                )}
              </Button>
            </div>

            {showAddForm && (
              <Card>
                <CardHeader>
                  <CardTitle>{editingId ? "Edit ACL Rule" : "Add New ACL Rule"}</CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="target">Target</Label>
                        <select
                          id="target"
                          value={formData.target}
                          onChange={(e) => setFormData({ ...formData, target: e.target.value })}
                          className="w-full px-3 py-2 border rounded-md"
                        >
                          <option value="system">System-wide</option>
                          <option value="master">Master Zones</option>
                          <option value="slave">Slave Zones</option>
                          <option value="cache">DNS Caching</option>
                          <option value="webui">Web UI</option>
                          <option value="doh">DNS over HTTPS</option>
                        </select>
                      </div>

                      <div>
                        <Label htmlFor="type">Type</Label>
                        <select
                          id="type"
                          value={formData.type}
                          onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                          className="w-full px-3 py-2 border rounded-md"
                        >
                          <option value="ip">IP Address</option>
                          <option value="network">Network (CIDR)</option>
                          <option value="country">Country Code</option>
                          <option value="asn">ASN</option>
                        </select>
                      </div>

                      <div>
                        <Label htmlFor="value">Value</Label>
                        <Input
                          id="value"
                          value={formData.value}
                          onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                          placeholder={
                            formData.type === "ip"
                              ? "192.168.1.1"
                              : formData.type === "network"
                              ? "192.168.0.0/24"
                              : formData.type === "country"
                              ? "US"
                              : "AS15169"
                          }
                          required
                        />
                      </div>

                      <div>
                        <Label htmlFor="action">Action</Label>
                        <select
                          id="action"
                          value={formData.action}
                          onChange={(e) => setFormData({ ...formData, action: e.target.value })}
                          className="w-full px-3 py-2 border rounded-md"
                        >
                          <option value="allow">Allow</option>
                          <option value="deny">Deny</option>
                        </select>
                      </div>

                      <div>
                        <Label htmlFor="priority">Priority</Label>
                        <Input
                          id="priority"
                          type="number"
                          value={formData.priority}
                          onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                          min="1"
                          max="1000"
                        />
                        <p className="text-xs text-gray-500 mt-1">Lower numbers = higher priority</p>
                      </div>

                      <div className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          id="enabled"
                          checked={formData.enabled}
                          onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                          className="rounded"
                        />
                        <Label htmlFor="enabled">Enabled</Label>
                      </div>
                    </div>

                    <div>
                      <Label htmlFor="description">Description (Optional)</Label>
                      <Input
                        id="description"
                        value={formData.description}
                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                        placeholder="e.g., Block spam network"
                      />
                    </div>

                    <div className="flex space-x-2">
                      <Button type="submit" disabled={loading}>
                        <Save className="mr-2 h-4 w-4" />
                        {editingId ? "Update Rule" : "Create Rule"}
                      </Button>
                      <Button type="button" variant="outline" onClick={resetForm}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>ACL Rules ({rules.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="text-center py-8">Loading...</div>
                ) : rules.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No ACL rules configured. Click "Add ACL Rule" to create one.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {rules.map((rule) => (
                      <div
                        key={rule.id}
                        className={`border rounded-lg p-4 ${rule.enabled ? "" : "opacity-50"}`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center space-x-2 mb-2">
                              <span className={`px-2 py-1 rounded text-xs font-medium ${
                                rule.action === "allow"
                                  ? "bg-green-100 text-green-800"
                                  : "bg-red-100 text-red-800"
                              }`}>
                                {rule.action.toUpperCase()}
                              </span>
                              <span className="px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800">
                                {targetLabels[rule.target] || rule.target}
                              </span>
                              <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-800">
                                {typeLabels[rule.type] || rule.type}: {rule.value}
                              </span>
                              <span className="text-xs text-gray-500">Priority: {rule.priority}</span>
                              {!rule.enabled && (
                                <span className="px-2 py-1 rounded text-xs font-medium bg-gray-200 text-gray-600">
                                  DISABLED
                                </span>
                              )}
                            </div>
                            {rule.description && (
                              <p className="text-sm text-muted-foreground">{rule.description}</p>
                            )}
                            <p className="text-xs text-gray-400 mt-1">
                              Created: {new Date(rule.created_at).toLocaleString()}
                            </p>
                          </div>
                          <div className="flex space-x-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleEdit(rule)}
                            >
                              <Edit2 className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleDelete(rule.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* Cache Configuration Tab */}
        {activeTab === "cache" && (
          <Card>
            <CardHeader>
              <CardTitle>DNS Cache Configuration</CardTitle>
              <p className="text-sm text-muted-foreground">
                Configure DNS caching behavior. Requires MyDNS restart to take effect.
              </p>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveCacheConfig} className="space-y-4">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="cache_enabled"
                    checked={cacheConfig.enabled}
                    onChange={(e) =>
                      setCacheConfig({ ...cacheConfig, enabled: e.target.checked })
                    }
                    className="rounded"
                  />
                  <Label htmlFor="cache_enabled">Enable DNS Caching</Label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="cache_size_mb">Cache Size (MB)</Label>
                    <Input
                      id="cache_size_mb"
                      type="number"
                      value={cacheConfig.cache_size_mb}
                      onChange={(e) =>
                        setCacheConfig({ ...cacheConfig, cache_size_mb: parseInt(e.target.value) })
                      }
                      min="1"
                      max="4096"
                    />
                    <p className="text-xs text-gray-500 mt-1">1-4096 MB</p>
                  </div>

                  <div>
                    <Label htmlFor="cache_ttl_min">Minimum TTL (seconds)</Label>
                    <Input
                      id="cache_ttl_min"
                      type="number"
                      value={cacheConfig.cache_ttl_min}
                      onChange={(e) =>
                        setCacheConfig({ ...cacheConfig, cache_ttl_min: parseInt(e.target.value) })
                      }
                      min="1"
                      max="86400"
                    />
                    <p className="text-xs text-gray-500 mt-1">1-86400 seconds</p>
                  </div>

                  <div>
                    <Label htmlFor="cache_ttl_max">Maximum TTL (seconds)</Label>
                    <Input
                      id="cache_ttl_max"
                      type="number"
                      value={cacheConfig.cache_ttl_max}
                      onChange={(e) =>
                        setCacheConfig({ ...cacheConfig, cache_ttl_max: parseInt(e.target.value) })
                      }
                      min="60"
                      max="604800"
                    />
                    <p className="text-xs text-gray-500 mt-1">60-604800 seconds (1 week)</p>
                  </div>

                  <div className="md:col-span-2">
                    <Label htmlFor="upstream_servers">Upstream DNS Servers</Label>
                    <Input
                      id="upstream_servers"
                      value={cacheConfig.upstream_servers}
                      onChange={(e) =>
                        setCacheConfig({ ...cacheConfig, upstream_servers: e.target.value })
                      }
                      placeholder="8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Comma-separated list of IP addresses or IP:PORT
                    </p>
                  </div>
                </div>

                <div className="flex space-x-2">
                  <Button type="submit" disabled={loading}>
                    <Save className="mr-2 h-4 w-4" />
                    Save Configuration
                  </Button>
                </div>

                <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                  <h4 className="font-semibold text-yellow-800 mb-2">Important Notes:</h4>
                  <ul className="text-sm text-yellow-700 space-y-1 list-disc list-inside">
                    <li>Changes require MyDNS server restart: <code className="bg-yellow-100 px-1">systemctl restart mydns</code></li>
                    <li>Configuration is stored in database and takes precedence over <code className="bg-yellow-100 px-1">mydns.conf</code></li>
                    <li>Slave servers without MySQL will use <code className="bg-yellow-100 px-1">mydns.conf</code> settings</li>
                  </ul>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
