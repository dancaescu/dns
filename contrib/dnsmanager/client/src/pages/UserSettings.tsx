import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Checkbox } from "../components/ui/checkbox";
import { apiRequest } from "../lib/api";
import { toast } from "../components/ui/toast";

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

export function UserSettings({ user, onLogout }: { user: any; onLogout: () => void }) {
  const navigate = useNavigate();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<NewToken | null>(null);
  const [createForm, setCreateForm] = useState({
    token_name: "",
    scopes: [] as string[],
    expires_in_days: 90,
  });

  // Profile settings
  const [email, setEmail] = useState(user?.email || "");
  const [fullName, setFullName] = useState(user?.full_name || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // 2FA settings
  const [require2FA, setRequire2FA] = useState(user?.require_2fa ? true : false);
  const [twofaMethod, setTwofaMethod] = useState<"email" | "sms" | "none">(user?.twofa_method || "none");
  const [twofaContact, setTwofaContact] = useState(user?.twofa_contact || "");

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
      toast({ title: "Success", description: "API token created" });
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

  async function handleUpdateProfile() {
    try {
      await apiRequest(`/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          email,
          full_name: fullName,
        }),
      });
      toast({ title: "Success", description: "Profile updated" });
    } catch (error) {
      console.error("Failed to update profile:", error);
      toast({ title: "Error", description: "Failed to update profile", variant: "destructive" });
    }
  }

  async function handleChangePassword() {
    if (newPassword !== confirmPassword) {
      toast({ title: "Error", description: "Passwords do not match", variant: "destructive" });
      return;
    }

    if (newPassword.length < 6) {
      toast({ title: "Error", description: "Password must be at least 6 characters", variant: "destructive" });
      return;
    }

    try {
      await apiRequest(`/users/${user.id}/password`, {
        method: "PUT",
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({ title: "Success", description: "Password changed successfully" });
    } catch (error) {
      console.error("Failed to change password:", error);
      toast({ title: "Error", description: "Failed to change password", variant: "destructive" });
    }
  }

  async function handleUpdate2FA() {
    if (require2FA && twofaMethod !== "none" && !twofaContact) {
      toast({ title: "Error", description: "Please provide a contact for 2FA", variant: "destructive" });
      return;
    }

    try {
      await apiRequest(`/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          require_2fa: require2FA,
          twofa_method: require2FA ? twofaMethod : "none",
          twofa_contact: require2FA && twofaMethod !== "none" ? twofaContact : null,
        }),
      });
      toast({ title: "Success", description: "2FA settings updated" });
    } catch (error) {
      console.error("Failed to update 2FA settings:", error);
      toast({ title: "Error", description: "Failed to update 2FA settings", variant: "destructive" });
    }
  }

  function toggleScope(scope: string) {
    if (scope === "*") {
      setCreateForm({ ...createForm, scopes: createForm.scopes.includes("*") ? [] : ["*"] });
    } else {
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
      <header className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">My Settings</h1>
          <p className="text-sm text-muted-foreground">Manage your profile and API tokens</p>
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
        <Tabs defaultValue="profile">
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            <TabsTrigger value="api-tokens">API Tokens</TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <Card>
              <CardHeader>
                <CardTitle>Profile Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="username">Username</Label>
                  <Input id="username" value={user?.username} disabled />
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="fullName">Full Name</Label>
                  <Input
                    id="fullName"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                  />
                </div>
                <Button onClick={handleUpdateProfile}>Update Profile</Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="security">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Change Password</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label htmlFor="currentPassword">Current Password</Label>
                    <Input
                      id="currentPassword"
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="newPassword">New Password</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="confirmPassword">Confirm New Password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                  </div>
                  <Button onClick={handleChangePassword}>Change Password</Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Two-Factor Authentication</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="require-2fa"
                      checked={require2FA}
                      onChange={(e) => setRequire2FA(e.target.checked)}
                      className="h-4 w-4"
                    />
                    <Label htmlFor="require-2fa" className="cursor-pointer">
                      Require Two-Factor Authentication
                    </Label>
                  </div>

                  {require2FA && (
                    <>
                      <div>
                        <Label htmlFor="twofa-method">2FA Method</Label>
                        <select
                          id="twofa-method"
                          value={twofaMethod}
                          onChange={(e) => setTwofaMethod(e.target.value as "email" | "sms" | "none")}
                          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="none">None</option>
                          <option value="email">Email</option>
                          <option value="sms">SMS</option>
                        </select>
                      </div>

                      {twofaMethod !== "none" && (
                        <div>
                          <Label htmlFor="twofa-contact">
                            {twofaMethod === "email" ? "Email Address" : "Phone Number"}
                          </Label>
                          <Input
                            id="twofa-contact"
                            type={twofaMethod === "email" ? "email" : "tel"}
                            value={twofaContact}
                            onChange={(e) => setTwofaContact(e.target.value)}
                            placeholder={twofaMethod === "email" ? "your.email@example.com" : "+1234567890"}
                          />
                        </div>
                      )}
                    </>
                  )}

                  <Button onClick={handleUpdate2FA}>Update 2FA Settings</Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="api-tokens">
            <Card>
              <CardHeader>
                <div className="flex justify-between items-center">
                  <CardTitle>My API Tokens</CardTitle>
                  <Button onClick={() => setShowCreateModal(true)}>Create New Token</Button>
                </div>
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
          </TabsContent>
        </Tabs>

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
