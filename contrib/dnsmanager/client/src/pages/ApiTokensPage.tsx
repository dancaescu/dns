import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Checkbox } from "../components/ui/checkbox";
import { apiRequest } from "../lib/api";
import { toast } from "../components/ui/toast";
import { UnifiedHeader } from "../components/UnifiedHeader";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

interface Token {
  id: number;
  token_name: string;
  token_prefix: string;
  scopes: string[];
  last_used: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  active: boolean;
  can_use_api: boolean;
  created_at: string;
}

interface NewToken {
  token: string;
  token_id: number;
  token_name: string;
  message: string;
}

const AVAILABLE_SCOPES = [
  { value: "*", label: "All Permissions", description: "Full access to all resources" },
  { value: "zones:read", label: "Zones: Read", description: "View zones" },
  { value: "zones:write", label: "Zones: Write", description: "Create/update/delete zones" },
  { value: "records:read", label: "Records: Read", description: "View DNS records" },
  { value: "records:write", label: "Records: Write", description: "Create/update/delete DNS records" },
  { value: "soa:read", label: "SOA: Read", description: "View SOA records" },
  { value: "soa:write", label: "SOA: Write", description: "Create/update/delete SOA records" },
  { value: "rr:read", label: "RR: Read", description: "View RR records" },
  { value: "rr:write", label: "RR: Write", description: "Create/update/delete RR records" },
  { value: "cloudflare:read", label: "Cloudflare: Read", description: "View Cloudflare records" },
  { value: "cloudflare:write", label: "Cloudflare: Write", description: "Manage Cloudflare records" },
];

export function ApiTokensPage({ onLogout, user }: { onLogout: () => void; user: User | null }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<NewToken | null>(null);
  const [createForm, setCreateForm] = useState({
    token_name: "",
    scopes: [] as string[],
    expires_in_days: 90,
  });

  useEffect(() => {
    loadTokens();
  }, []);

  async function loadTokens() {
    try {
      const response = await apiRequest<{ tokens: Token[] }>("/tokens");
      setTokens(response.tokens);
    } catch (error) {
      console.error("Failed to load tokens:", error);
      toast({ title: "Error", description: "Failed to load tokens", variant: "destructive" });
    }
  }

  async function handleCreateToken() {
    if (!createForm.token_name || createForm.scopes.length === 0) {
      toast({ title: "Error", description: "Please provide a name and select at least one scope", variant: "destructive" });
      return;
    }

    try {
      const response = await apiRequest<NewToken>("/tokens", {
        method: "POST",
        body: JSON.stringify(createForm),
      });

      setNewlyCreatedToken(response);
      setShowCreateModal(false);
      setShowTokenModal(true);
      setCreateForm({
        token_name: "",
        scopes: [],
        expires_in_days: 90,
      });
      loadTokens();
    } catch (error) {
      console.error("Failed to create token:", error);
      toast({ title: "Error", description: "Failed to create token", variant: "destructive" });
    }
  }

  async function handleRevokeToken(tokenId: number) {
    if (!confirm("Revoke this API token? This action cannot be undone.")) return;

    try {
      await apiRequest(`/tokens/${tokenId}`, {
        method: "DELETE",
      });

      toast({ title: "Success", description: "Token revoked" });
      loadTokens();
    } catch (error) {
      console.error("Failed to revoke token:", error);
      toast({ title: "Error", description: "Failed to revoke token", variant: "destructive" });
    }
  }

  function toggleScope(scope: string) {
    if (scope === "*") {
      // If selecting "all", clear other scopes
      setCreateForm({ ...createForm, scopes: createForm.scopes.includes("*") ? [] : ["*"] });
    } else {
      // If selecting specific scope, remove "all" if present
      const newScopes = createForm.scopes.includes(scope)
        ? createForm.scopes.filter(s => s !== scope && s !== "*")
        : [...createForm.scopes.filter(s => s !== "*"), scope];
      setCreateForm({ ...createForm, scopes: newScopes });
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: "Token copied to clipboard" });
  }

  function formatDate(dateString: string | null) {
    if (!dateString) return "Never";
    return new Date(dateString).toLocaleString();
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <UnifiedHeader
        title="API Tokens"
        subtitle="Manage your API access tokens"
        onLogout={onLogout}
        user={user}
      />
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        <div className="flex justify-end">
          <Button onClick={() => setShowCreateModal(true)}>Create New Token</Button>
        </div>

      <Card>
        <CardHeader>
          <CardTitle>Your API Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-500">
                    No API tokens. Create one to get started.
                  </TableCell>
                </TableRow>
              ) : (
                tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.token_name}</TableCell>
                    <TableCell>
                      <code className="text-xs bg-gray-100 px-2 py-1 rounded">{token.token_prefix}...</code>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {token.scopes.map((scope) => (
                          <span key={scope} className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                            {scope}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {formatDate(token.last_used)}
                        {token.last_used_ip && (
                          <div className="text-xs text-gray-500">{token.last_used_ip}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(token.expires_at)}</TableCell>
                    <TableCell>
                      {token.active && token.can_use_api ? (
                        <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs">Active</span>
                      ) : !token.can_use_api ? (
                        <span className="px-2 py-1 bg-yellow-100 text-yellow-800 rounded text-xs">API Disabled</span>
                      ) : (
                        <span className="px-2 py-1 bg-gray-100 text-gray-800 rounded text-xs">Inactive</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="destructive" onClick={() => handleRevokeToken(token.id)}>
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create Token Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <CardTitle>Create New API Token</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Token Name</Label>
                <Input
                  placeholder="e.g., Production API Access"
                  value={createForm.token_name}
                  onChange={(e) => setCreateForm({ ...createForm, token_name: e.target.value })}
                />
              </div>

              <div>
                <Label>Expires In (Days)</Label>
                <Input
                  type="number"
                  min="1"
                  max="365"
                  value={createForm.expires_in_days}
                  onChange={(e) => setCreateForm({ ...createForm, expires_in_days: parseInt(e.target.value) || 90 })}
                />
              </div>

              <div>
                <Label className="mb-2 block">Scopes (Permissions)</Label>
                <div className="space-y-2 border rounded p-4 max-h-60 overflow-y-auto">
                  {AVAILABLE_SCOPES.map((scope) => (
                    <div key={scope.value} className="flex items-start space-x-2">
                      <Checkbox
                        id={`scope-${scope.value}`}
                        checked={createForm.scopes.includes(scope.value)}
                        onCheckedChange={() => toggleScope(scope.value)}
                      />
                      <div className="flex-1">
                        <label htmlFor={`scope-${scope.value}`} className="text-sm font-medium cursor-pointer">
                          {scope.label}
                        </label>
                        <p className="text-xs text-gray-500">{scope.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreateToken}>Create Token</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Show New Token Modal */}
      {showTokenModal && newlyCreatedToken && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <CardTitle>Token Created Successfully</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-yellow-50 border border-yellow-200 p-4 rounded">
                <p className="text-sm font-medium text-yellow-800">
                  ⚠️ Save this token now! You won't be able to see it again.
                </p>
              </div>

              <div>
                <Label>Your API Token</Label>
                <div className="flex gap-2 mt-2">
                  <Input
                    value={newlyCreatedToken.token}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button onClick={() => copyToClipboard(newlyCreatedToken.token)}>
                    Copy
                  </Button>
                </div>
              </div>

              <div>
                <Label>Token Name</Label>
                <p className="text-sm mt-1">{newlyCreatedToken.token_name}</p>
              </div>

              <div className="bg-blue-50 border border-blue-200 p-4 rounded">
                <p className="text-sm text-blue-800">
                  Use this token in your API requests by adding it to the Authorization header:
                </p>
                <code className="block mt-2 bg-white p-2 rounded text-xs">
                  Authorization: Bearer {newlyCreatedToken.token}
                </code>
              </div>

              <div className="flex gap-2 justify-end">
                <Button onClick={() => {
                  setShowTokenModal(false);
                  setNewlyCreatedToken(null);
                }}>
                  Done
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
      </main>
    </div>
  );
}
