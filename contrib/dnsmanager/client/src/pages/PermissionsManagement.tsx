import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import { apiRequest } from "../lib/api";
import { toast } from "../components/ui/toast";

interface User {
  id: number;
  username: string;
  email: string;
  is_account_admin: boolean;
  permissions: Permission[];
}

interface Permission {
  id: number;
  permission_type: string;
  zone_type: string | null;
  resource_id: number | null;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

interface Account {
  id: number;
  name: string;
}

interface Zone {
  id: number;
  name: string;
  zone_type: 'soa' | 'cloudflare';
}

export function PermissionsManagement() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [users, setUsers] = useState<User[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [showGrantModal, setShowGrantModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [grantForm, setGrantForm] = useState({
    permission_type: "zone",
    zone_type: "soa",
    resource_id: "",
    can_view: true,
    can_add: false,
    can_edit: false,
    can_delete: false,
  });

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      loadUsers(selectedAccountId);
      loadZones();
    }
  }, [selectedAccountId]);

  async function loadAccounts() {
    try {
      const response = await apiRequest<{ accounts: Account[] }>("/users/accounts");
      setAccounts(response.accounts || []);
      if (response.accounts && response.accounts.length > 0) {
        setSelectedAccountId(response.accounts[0].id.toString());
      }
    } catch (error) {
      console.error("Failed to load accounts:", error);
    }
  }

  async function loadUsers(accountId: string) {
    try {
      const response = await apiRequest<{ users: User[] }>(`/permissions/users/${accountId}`);
      setUsers(response.users);
    } catch (error) {
      console.error("Failed to load users:", error);
      toast({ title: "Error", description: "Failed to load users", variant: "destructive" });
    }
  }

  async function loadZones() {
    try {
      const response = await apiRequest<{ soa_zones: Zone[]; cloudflare_zones: Zone[] }>("/permissions/zones");
      const allZones = [
        ...response.soa_zones.map(z => ({ ...z, zone_type: 'soa' as const })),
        ...response.cloudflare_zones.map(z => ({ ...z, zone_type: 'cloudflare' as const }))
      ];
      setZones(allZones);
    } catch (error) {
      console.error("Failed to load zones:", error);
    }
  }

  async function handleGrantPermission() {
    if (!selectedUser) return;

    try {
      await apiRequest("/permissions/users/grant", {
        method: "POST",
        body: JSON.stringify({
          user_id: selectedUser.id,
          permission_type: grantForm.permission_type,
          zone_type: grantForm.zone_type || null,
          resource_id: grantForm.resource_id ? parseInt(grantForm.resource_id) : null,
          can_view: grantForm.can_view,
          can_add: grantForm.can_add,
          can_edit: grantForm.can_edit,
          can_delete: grantForm.can_delete,
        }),
      });

      toast({ title: "Success", description: "Permission granted" });
      setShowGrantModal(false);
      setSelectedUser(null);
      setGrantForm({
        permission_type: "zone",
        zone_type: "soa",
        resource_id: "",
        can_view: true,
        can_add: false,
        can_edit: false,
        can_delete: false,
      });
      if (selectedAccountId) {
        loadUsers(selectedAccountId);
      }
    } catch (error) {
      console.error("Failed to grant permission:", error);
      toast({ title: "Error", description: "Failed to grant permission", variant: "destructive" });
    }
  }

  async function handleRevokePermission(permissionId: number) {
    if (!confirm("Revoke this permission?")) return;

    try {
      await apiRequest(`/permissions/users/${permissionId}`, {
        method: "DELETE",
      });

      toast({ title: "Success", description: "Permission revoked" });
      if (selectedAccountId) {
        loadUsers(selectedAccountId);
      }
    } catch (error) {
      console.error("Failed to revoke permission:", error);
      toast({ title: "Error", description: "Failed to revoke permission", variant: "destructive" });
    }
  }

  function openGrantModal(user: User) {
    setSelectedUser(user);
    setShowGrantModal(true);
  }

  function getZoneName(zoneType: string | null, resourceId: number | null) {
    if (!zoneType || !resourceId) return "N/A";
    const zone = zones.find(z => z.zone_type === zoneType && z.id === resourceId);
    return zone ? zone.name : `Zone #${resourceId}`;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">User Permissions Management</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Select Account</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id.toString()}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {selectedAccountId && (
        <Card>
          <CardHeader>
            <CardTitle>Users & Permissions</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.username}</TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>
                      {user.is_account_admin ? (
                        <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs">Account Admin</span>
                      ) : (
                        <span className="px-2 py-1 bg-gray-100 text-gray-800 rounded text-xs">User</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.permissions && user.permissions.length > 0 ? (
                        <div className="space-y-1">
                          {user.permissions.map((perm) => (
                            <div key={perm.id} className="text-sm flex items-center gap-2">
                              <span className="font-medium">{perm.permission_type}</span>
                              {perm.zone_type && (
                                <span className="text-xs text-gray-500">
                                  ({perm.zone_type}: {getZoneName(perm.zone_type, perm.resource_id)})
                                </span>
                              )}
                              <span className="text-xs text-gray-500">
                                [{perm.can_view ? "V" : "-"}
                                {perm.can_add ? "A" : "-"}
                                {perm.can_edit ? "E" : "-"}
                                {perm.can_delete ? "D" : "-"}]
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleRevokePermission(perm.id)}
                              >
                                Revoke
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-500">No permissions</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" onClick={() => openGrantModal(user)}>
                        Grant Permission
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Grant Permission Modal */}
      {showGrantModal && selectedUser && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Grant Permission to {selectedUser.username}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Permission Type</Label>
                <Select
                  value={grantForm.permission_type}
                  onValueChange={(value) => setGrantForm({ ...grantForm, permission_type: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zone">Zone</SelectItem>
                    <SelectItem value="soa">SOA</SelectItem>
                    <SelectItem value="rr">RR</SelectItem>
                    <SelectItem value="cloudflare">Cloudflare</SelectItem>
                    <SelectItem value="user_management">User Management</SelectItem>
                    <SelectItem value="load_balancer">Load Balancer</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {grantForm.permission_type === "zone" && (
                <>
                  <div>
                    <Label>Zone Type</Label>
                    <Select
                      value={grantForm.zone_type}
                      onValueChange={(value) => setGrantForm({ ...grantForm, zone_type: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="soa">SOA</SelectItem>
                        <SelectItem value="cloudflare">Cloudflare</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>Zone</Label>
                    <Select
                      value={grantForm.resource_id}
                      onValueChange={(value) => setGrantForm({ ...grantForm, resource_id: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select zone" />
                      </SelectTrigger>
                      <SelectContent>
                        {zones
                          .filter(z => z.zone_type === grantForm.zone_type)
                          .map((zone) => (
                            <SelectItem key={zone.id} value={zone.id.toString()}>
                              {zone.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label>Permissions</Label>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="grant_can_view"
                    checked={grantForm.can_view}
                    onCheckedChange={(checked) =>
                      setGrantForm({ ...grantForm, can_view: checked as boolean })
                    }
                  />
                  <label htmlFor="grant_can_view" className="text-sm">
                    View
                  </label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="grant_can_add"
                    checked={grantForm.can_add}
                    onCheckedChange={(checked) =>
                      setGrantForm({ ...grantForm, can_add: checked as boolean })
                    }
                  />
                  <label htmlFor="grant_can_add" className="text-sm">
                    Add
                  </label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="grant_can_edit"
                    checked={grantForm.can_edit}
                    onCheckedChange={(checked) =>
                      setGrantForm({ ...grantForm, can_edit: checked as boolean })
                    }
                  />
                  <label htmlFor="grant_can_edit" className="text-sm">
                    Edit
                  </label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="grant_can_delete"
                    checked={grantForm.can_delete}
                    onCheckedChange={(checked) =>
                      setGrantForm({ ...grantForm, can_delete: checked as boolean })
                    }
                  />
                  <label htmlFor="grant_can_delete" className="text-sm">
                    Delete
                  </label>
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowGrantModal(false)}>
                  Cancel
                </Button>
                <Button onClick={handleGrantPermission}>Grant Permission</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
