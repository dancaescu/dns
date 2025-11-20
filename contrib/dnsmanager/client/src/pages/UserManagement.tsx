import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { apiRequest } from "../lib/api";

interface User {
  id: number;
  username: string;
  email: string;
  full_name: string | null;
  role: "superadmin" | "account_admin" | "user";
  active: number;
  require_2fa: number;
  twofa_method: "email" | "sms" | "none";
  last_login: string | null;
  created_at: string;
}

interface Session {
  id: number;
  user_id: number;
  username: string;
  email: string;
  role: string;
  ip_address: string;
  current_page: string | null;
  last_activity: string;
  login_at: string;
}

interface Log {
  id: number;
  user_id: number | null;
  username: string | null;
  action_type: string;
  resource_type: string | null;
  resource_id: number | null;
  description: string;
  ip_address: string;
  created_at: string;
}

export function UserManagement({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const [users, setUsers] = useState<User[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [newUser, setNewUser] = useState({
    username: "",
    email: "",
    password: "",
    full_name: "",
    role: "user" as "superadmin" | "account_admin" | "user",
    active: true,
  });

  useEffect(() => {
    loadUsers();
    loadSessions();
    loadLogs();
  }, []);

  async function loadUsers() {
    try {
      const response = await apiRequest<{ users: User[] }>("/users");
      setUsers(response.users);
    } catch (error) {
      console.error("Failed to load users:", error);
    }
  }

  async function loadSessions() {
    try {
      const response = await apiRequest<{ sessions: Session[] }>("/users/sessions/active");
      setSessions(response.sessions);
    } catch (error) {
      console.error("Failed to load sessions:", error);
    }
  }

  async function loadLogs() {
    try {
      const response = await apiRequest<{ logs: Log[] }>("/users/logs?limit=100");
      setLogs(response.logs);
    } catch (error) {
      console.error("Failed to load logs:", error);
    }
  }

  async function handleCreateUser() {
    try {
      await apiRequest("/users", {
        method: "POST",
        body: JSON.stringify(newUser),
      });
      setShowAddUserModal(false);
      setNewUser({
        username: "",
        email: "",
        password: "",
        full_name: "",
        role: "user",
        active: true,
      });
      loadUsers();
      alert("User created successfully!");
    } catch (error) {
      console.error("Failed to create user:", error);
      alert("Failed to create user");
    }
  }

  async function handleUpdateUser(userId: number, updates: Partial<User>) {
    try {
      await apiRequest(`/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
      setEditingUser(null);
      loadUsers();
      alert("User updated successfully!");
    } catch (error) {
      console.error("Failed to update user:", error);
      alert("Failed to update user");
    }
  }

  async function handleDeleteUser(userId: number, username: string) {
    if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
      return;
    }
    try {
      await apiRequest(`/users/${userId}`, {
        method: "DELETE",
      });
      loadUsers();
      alert("User deleted successfully!");
    } catch (error) {
      console.error("Failed to delete user:", error);
      alert("Failed to delete user");
    }
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">User Management</h1>
          <p className="text-sm text-muted-foreground">Manage users, permissions, and audit logs</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => navigate("/")}>
            Dashboard
          </Button>
          <Button variant="outline" onClick={() => navigate("/settings")}>
            Settings
          </Button>
          <Button variant="outline" onClick={onLogout}>
            Logout
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        <Tabs defaultValue="users">
          <TabsList>
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="sessions">Active Sessions</TabsTrigger>
            <TabsTrigger value="logs">Audit Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="users">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Users</CardTitle>
                <Button onClick={() => setShowAddUserModal(true)}>Add User</Button>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Username</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Full Name</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>2FA</TableHead>
                        <TableHead>Last Login</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {users.map((user) => (
                        <TableRow key={user.id}>
                          <TableCell className="font-medium">{user.username}</TableCell>
                          <TableCell>{user.email}</TableCell>
                          <TableCell>{user.full_name || "-"}</TableCell>
                          <TableCell>
                            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                              user.role === "superadmin" ? "bg-purple-100 text-purple-700" :
                              user.role === "account_admin" ? "bg-blue-100 text-blue-700" :
                              "bg-gray-100 text-gray-700"
                            }`}>
                              {user.role}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                              user.active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                            }`}>
                              {user.active ? "Active" : "Inactive"}
                            </span>
                          </TableCell>
                          <TableCell>{user.twofa_method !== "none" ? user.twofa_method : "Disabled"}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {user.last_login ? new Date(user.last_login).toLocaleString() : "Never"}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingUser(user)}
                                className="text-blue-600"
                              >
                                Edit
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteUser(user.id, user.username)}
                                className="text-red-600"
                              >
                                Delete
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="sessions">
            <Card>
              <CardHeader>
                <CardTitle>Active Sessions ({sessions.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>IP Address</TableHead>
                        <TableHead>Current Page</TableHead>
                        <TableHead>Last Activity</TableHead>
                        <TableHead>Login Time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sessions.map((session) => (
                        <TableRow key={session.id}>
                          <TableCell>
                            <div>
                              <div className="font-medium">{session.username}</div>
                              <div className="text-sm text-muted-foreground">{session.email}</div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                              session.role === "superadmin" ? "bg-purple-100 text-purple-700" :
                              session.role === "account_admin" ? "bg-blue-100 text-blue-700" :
                              "bg-gray-100 text-gray-700"
                            }`}>
                              {session.role}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-sm">{session.ip_address}</TableCell>
                          <TableCell className="text-sm">{session.current_page || "-"}</TableCell>
                          <TableCell className="text-sm">
                            {new Date(session.last_activity).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-sm">
                            {new Date(session.login_at).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="logs">
            <Card>
              <CardHeader>
                <CardTitle>Audit Logs (Last 100)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>User</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>IP Address</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {logs.map((log) => (
                        <TableRow key={log.id}>
                          <TableCell className="text-sm">
                            {new Date(log.created_at).toLocaleString()}
                          </TableCell>
                          <TableCell className="font-medium">
                            {log.username || "System"}
                          </TableCell>
                          <TableCell>
                            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                              log.action_type.includes("create") ? "bg-green-100 text-green-700" :
                              log.action_type.includes("delete") ? "bg-red-100 text-red-700" :
                              log.action_type.includes("update") ? "bg-blue-100 text-blue-700" :
                              log.action_type.includes("login") ? "bg-purple-100 text-purple-700" :
                              "bg-gray-100 text-gray-700"
                            }`}>
                              {log.action_type}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-md truncate text-sm">{log.description}</TableCell>
                          <TableCell className="font-mono text-sm">{log.ip_address}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Add User Modal */}
      {showAddUserModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h2 className="mb-4 text-lg font-semibold">Add New User</h2>
            <div className="space-y-4">
              <div>
                <Label htmlFor="new-user-username">Username *</Label>
                <Input
                  id="new-user-username"
                  value={newUser.username}
                  onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="new-user-email">Email *</Label>
                <Input
                  id="new-user-email"
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="new-user-password">Password *</Label>
                <Input
                  id="new-user-password"
                  type="password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="new-user-full-name">Full Name</Label>
                <Input
                  id="new-user-full-name"
                  value={newUser.full_name}
                  onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="new-user-role">Role *</Label>
                <select
                  id="new-user-role"
                  className="w-full rounded-md border px-3 py-2"
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value as any })}
                >
                  <option value="user">User</option>
                  <option value="account_admin">Account Admin</option>
                  <option value="superadmin">Superadmin</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="new-user-active"
                  checked={newUser.active}
                  onChange={(e) => setNewUser({ ...newUser, active: e.target.checked })}
                />
                <Label htmlFor="new-user-active" className="cursor-pointer">
                  Active
                </Label>
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowAddUserModal(false);
                    setNewUser({
                      username: "",
                      email: "",
                      password: "",
                      full_name: "",
                      role: "user",
                      active: true,
                    });
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={handleCreateUser}>Create User</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h2 className="mb-4 text-lg font-semibold">Edit User</h2>
            <div className="space-y-4">
              <div>
                <Label>Username</Label>
                <Input value={editingUser.username} disabled />
              </div>
              <div>
                <Label htmlFor="edit-user-email">Email *</Label>
                <Input
                  id="edit-user-email"
                  type="email"
                  value={editingUser.email}
                  onChange={(e) => setEditingUser({ ...editingUser, email: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="edit-user-full-name">Full Name</Label>
                <Input
                  id="edit-user-full-name"
                  value={editingUser.full_name || ""}
                  onChange={(e) => setEditingUser({ ...editingUser, full_name: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="edit-user-role">Role *</Label>
                <select
                  id="edit-user-role"
                  className="w-full rounded-md border px-3 py-2"
                  value={editingUser.role}
                  onChange={(e) => setEditingUser({ ...editingUser, role: e.target.value as any })}
                >
                  <option value="user">User</option>
                  <option value="account_admin">Account Admin</option>
                  <option value="superadmin">Superadmin</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="edit-user-active"
                  checked={Boolean(editingUser.active)}
                  onChange={(e) => setEditingUser({ ...editingUser, active: e.target.checked ? 1 : 0 })}
                />
                <Label htmlFor="edit-user-active" className="cursor-pointer">
                  Active
                </Label>
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <Button variant="ghost" onClick={() => setEditingUser(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    handleUpdateUser(editingUser.id, {
                      email: editingUser.email,
                      full_name: editingUser.full_name,
                      role: editingUser.role,
                      active: editingUser.active,
                    })
                  }
                >
                  Update User
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
