import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import { apiRequest } from "../lib/api";
import { toast, ToastContainer } from "../components/ui/toast";
import { UnifiedHeader } from "../components/UnifiedHeader";

interface User {
  id: number;
  username: string;
  email: string;
  full_name: string | null;
  role: "superadmin" | "account_admin" | "user";
  active: number;
  require_2fa: number;
  twofa_method: "email" | "sms" | "none";
  twofa_contact: string | null;
  managed_by: number | null;
  managed_by_username: string | null;
  last_login: string | null;
  created_at: string;
}

interface AccountAdmin {
  id: number;
  username: string;
  email: string;
  full_name: string | null;
  role: string;
}

interface UserUpdatePayload {
  email?: string;
  full_name?: string | null;
  role?: "superadmin" | "account_admin" | "user";
  active?: boolean;
  require_2fa?: boolean;
  twofa_method?: "email" | "sms" | "none";
  twofa_contact?: string | null;
  managed_by?: number | null;
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
  isRestored?: boolean;
}

interface Zone {
  id: number | null;  // null for "create new" permissions
  origin: string;
  zone_type: 'soa' | 'cloudflare';
  isCreatePermission?: boolean;
}

interface ZoneAssignment {
  zone_type: 'soa' | 'cloudflare';
  zone_id: number | null;  // null for "create new" permissions
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_api_access: boolean;
}

interface Permission {
  id: number;
  permission_type?: string;
  zone_type?: 'soa' | 'cloudflare';
  zone_id?: number | null;  // null for "create new" permissions
  resource_id?: number;
  zone_name?: string;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_api_access?: boolean;
}

interface ApiToken {
  id: number;
  token_name: string;
  token_prefix: string;
  active: boolean;
  can_use_api: boolean;
}

export function UserManagement({ onLogout, user }: { onLogout: () => void; user: User | null }) {
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
    require_2fa: false,
    twofa_method: "none" as "email" | "sms" | "none",
    twofa_contact: "",
    managed_by: null as number | null,
  });

  // Account admins list
  const [accountAdmins, setAccountAdmins] = useState<AccountAdmin[]>([]);

  // Password reset state
  const [showResetPasswordModal, setShowResetPasswordModal] = useState(false);
  const [userToResetPassword, setUserToResetPassword] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // Zone assignment state
  const [showZoneAssignModal, setShowZoneAssignModal] = useState(false);
  const [selectedUserForZones, setSelectedUserForZones] = useState<User | null>(null);
  const [allZones, setAllZones] = useState<Zone[]>([]);
  const [assignedZones, setAssignedZones] = useState<Map<string, ZoneAssignment>>(new Map());
  const [selectedZoneKey, setSelectedZoneKey] = useState<string | null>(null);
  const [searchAvailable, setSearchAvailable] = useState('');
  const [searchAssigned, setSearchAssigned] = useState('');
  const [zoneTypeFilter, setZoneTypeFilter] = useState<'all' | 'soa' | 'cloudflare'>('all');
  const [selectedUserApiAccessEnabled, setSelectedUserApiAccessEnabled] = useState(false);
  const [expandedSection, setExpandedSection] = useState<'accounts' | 'zones'>('zones');

  // Cloudflare account assignment state
  const [cloudflareAccounts, setCloudflareAccounts] = useState<Array<{
    id: number;
    name: string;
    cf_account_id: string;
  }>>([]);
  const [assignedAccounts, setAssignedAccounts] = useState<Map<number, {
    can_view: boolean;
    can_add: boolean;
    can_edit: boolean;
    can_delete: boolean;
    can_api_access: boolean;
  }>>(new Map());

  // Permission management state
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [selectedUserForPerms, setSelectedUserForPerms] = useState<User | null>(null);
  const [userPermissions, setUserPermissions] = useState<Permission[]>([]);
  const [userApiAccessEnabled, setUserApiAccessEnabled] = useState(false);

  // API access state
  const [userApiTokens, setUserApiTokens] = useState<Record<number, ApiToken[]>>({});

  // Delete user confirmation modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [userToDelete, setUserToDelete] = useState<{ id: number; username: string } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // Audit log filters
  const [logFilters, setLogFilters] = useState({
    dateFrom: '',
    dateTo: '',
    user: '',
    action: '',
    ipAddress: '',
    description: '',
    domain: ''
  });
  const [logPage, setLogPage] = useState(1);
  const [logPerPage, setLogPerPage] = useState(15);
  const [logTotalCount, setLogTotalCount] = useState(0);
  const [userSearchOpen, setUserSearchOpen] = useState(false);
  const [actionSearchOpen, setActionSearchOpen] = useState(false);
  const [domainSearchOpen, setDomainSearchOpen] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [actionSearchQuery, setActionSearchQuery] = useState('');
  const [domainSearchQuery, setDomainSearchQuery] = useState('');
  const [allDomains, setAllDomains] = useState<string[]>([]);

  useEffect(() => {
    loadUsers();
    loadSessions();
    loadLogs();
    loadDomains();
    loadAccountAdmins();
  }, []);

  useEffect(() => {
    loadLogs();
  }, [logPage, logPerPage, logFilters]);

  async function loadUsers() {
    try {
      const response = await apiRequest<{ users: User[] }>("/users");
      setUsers(response.users);

      // Load API tokens for all users
      response.users.forEach(user => {
        loadApiTokensForUser(user.id);
      });
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
      const params = new URLSearchParams({
        page: logPage.toString(),
        limit: logPerPage.toString(),
        ...(logFilters.dateFrom && { dateFrom: logFilters.dateFrom }),
        ...(logFilters.dateTo && { dateTo: logFilters.dateTo }),
        ...(logFilters.user && { user: logFilters.user }),
        ...(logFilters.action && { action: logFilters.action }),
        ...(logFilters.ipAddress && { ipAddress: logFilters.ipAddress }),
        ...(logFilters.description && { description: logFilters.description }),
        ...(logFilters.domain && { domain: logFilters.domain })
      });
      const data = await apiRequest<{ logs: Log[]; total: number }>(`/logs?${params.toString()}`);
      setLogs(data.logs);
      setLogTotalCount(data.total);
    } catch (error) {
      console.error("Failed to load logs:", error);
    }
  }

  async function loadDomains() {
    try {
      // Load both SOA and Cloudflare zones
      const [soaZones, cfZones] = await Promise.all([
        apiRequest<Array<{ id: number; origin: string }>>('/soa'),
        apiRequest<Array<{ id: number; name: string }>>('/cloudflare/zones')
      ]);

      const domains = [
        ...soaZones.map(z => z.origin),
        ...cfZones.map(z => z.name)
      ].sort();

      setAllDomains(domains);
    } catch (error) {
      console.error("Failed to load domains:", error);
    }
  }

  async function loadAccountAdmins() {
    try {
      const response = await apiRequest<{ admins: AccountAdmin[] }>("/users/account-admins");
      setAccountAdmins(response.admins);
    } catch (error) {
      console.error("Failed to load account admins:", error);
    }
  }

  async function handleRestoreRecord(logId: number) {
    try {
      await apiRequest(`/logs/restore/${logId}`, { method: "POST" });
      toast.success("Record restored successfully");
      // Reload logs to show the restore action
      loadLogs();
    } catch (error: any) {
      toast.error(error.message || "Failed to restore record");
    }
  }

  function handleViewRecord(log: Log) {
    // Navigate to the appropriate page based on resource_type
    if (log.resource_type === 'dns_record' && log.resource_id) {
      // For DNS records, we need to navigate to zones page
      // The zones page will need to support deep linking to specific records
      navigate('/zones');
    } else if (log.resource_type === 'zone' && log.resource_id) {
      navigate('/zones');
    } else if (log.resource_type === 'user' && log.resource_id) {
      navigate('/users');
    }
    // Add more resource type handling as needed
  }

  function applyFilters() {
    // Reset to page 1 when applying filters
    setLogPage(1);
    loadLogs();
  }

  function clearFilters() {
    setLogFilters({
      dateFrom: '',
      dateTo: '',
      user: '',
      action: '',
      ipAddress: '',
      description: '',
      domain: ''
    });
    setLogPage(1);
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
      toast.success("User created successfully");
    } catch (error) {
      console.error("Failed to create user:", error);
      const message = error instanceof Error ? error.message : "Failed to create user";
      toast.error(message);
    }
  }

  async function handleUpdateUser(userId: number, updates: UserUpdatePayload) {
    try {
      await apiRequest(`/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
      setEditingUser(null);
      loadUsers();
      toast.success("User updated successfully");
    } catch (error) {
      console.error("Failed to update user:", error);
      const message = error instanceof Error ? error.message : "Failed to update user";
      toast.error(message);
    }
  }

  async function handleResetPassword() {
    if (!userToResetPassword || !newPassword) {
      toast.error("Please enter a new password");
      return;
    }

    try {
      const response = await apiRequest<{ success: boolean; message: string }>(
        `/users/${userToResetPassword.id}/reset-password`,
        {
          method: "POST",
          body: JSON.stringify({ new_password: newPassword }),
        }
      );
      setShowResetPasswordModal(false);
      setUserToResetPassword(null);
      setNewPassword("");
      toast.success(response.message || "Password reset successfully");
    } catch (error) {
      console.error("Failed to reset password:", error);
      const message = error instanceof Error ? error.message : "Failed to reset password";
      toast.error(message);
    }
  }

  async function handleTerminateSession(sessionId: number) {
    if (!confirm("Are you sure you want to terminate this session?")) return;

    try {
      await apiRequest(`/users/sessions/${sessionId}`, {
        method: "DELETE",
      });
      loadSessions();
      toast.success("Session terminated successfully");
    } catch (error) {
      console.error("Failed to terminate session:", error);
      const message = error instanceof Error ? error.message : "Failed to terminate session";
      toast.error(message);
    }
  }

  function handleDeleteUser(userId: number, username: string) {
    // Show confirmation modal instead of simple confirm
    setUserToDelete({ id: userId, username });
    setDeleteConfirmText('');
    setShowDeleteModal(true);
  }

  async function confirmDeleteUser() {
    if (!userToDelete) return;

    if (deleteConfirmText !== userToDelete.username) {
      toast.error("Username does not match. Please type the exact username to confirm deletion.");
      return;
    }

    try {
      await apiRequest(`/users/${userToDelete.id}`, {
        method: "DELETE",
      });
      loadUsers();
      toast.success("User deleted successfully");
      setShowDeleteModal(false);
      setUserToDelete(null);
      setDeleteConfirmText('');
    } catch (error) {
      console.error("Failed to delete user:", error);
      const message = error instanceof Error ? error.message : "Failed to delete user";
      toast.error(message);
    }
  }

  async function handleToggleApiAccess(userId: number, currentStatus: boolean) {
    try {
      await apiRequest(`/permissions/api-access/${userId}/enable`, {
        method: "POST",
        body: JSON.stringify({ enabled: !currentStatus }),
      });
      toast.success(`API access ${!currentStatus ? 'enabled' : 'disabled'}`);
      loadApiTokensForUser(userId);
    } catch (error) {
      console.error("Failed to toggle API access:", error);
      const message = error instanceof Error ? error.message : "Failed to toggle API access";
      toast.error(message);
    }
  }

  async function handleRestoreRecord(recordId: number) {
    try {
      await apiRequest(`/rr/${recordId}/restore`, {
        method: "POST",
      });
      toast.success("DNS record restored successfully");
      loadLogs(); // Reload logs to show the restore action
    } catch (error) {
      console.error("Failed to restore record:", error);
      const message = error instanceof Error ? error.message : "Failed to restore record";
      toast.error(message);
    }
  }

  async function loadApiTokensForUser(userId: number) {
    try {
      const response = await apiRequest<{ tokens: ApiToken[] }>(`/permissions/api-access/${userId}`);
      setUserApiTokens(prev => ({ ...prev, [userId]: response.tokens }));
    } catch (error) {
      console.error("Failed to load API tokens:", error);
    }
  }

  async function openZoneAssignModal(user: User) {
    setSelectedUserForZones(user);
    setShowZoneAssignModal(true);
    setSearchAvailable('');
    setSearchAssigned('');
    setZoneTypeFilter('all');
    setSelectedZoneKey(null);

    // Load all zones, existing permissions, API access status, and Cloudflare accounts
    try {
      const [zonesResponse, permsResponse, apiResponse, accountsResponse] = await Promise.all([
        apiRequest<{ zones: Zone[] }>("/permissions/zones"),
        apiRequest<{ permissions: Permission[] }>(`/permissions/users/by-user/${user.id}`),
        apiRequest<{ tokens: ApiToken[] }>(`/permissions/api-access/${user.id}`),
        apiRequest<{ accounts: Array<{ id: number; name: string; cf_account_id: string }> }>("/permissions/cloudflare-accounts")
      ]);

      console.log("Zones response:", zonesResponse);

      // Add special "create new" permissions to the zones list
      const zonesWithCreatePermissions = [
        { id: null, origin: '✨ New SOA Zone', zone_type: 'soa' as const, isCreatePermission: true },
        { id: null, origin: '✨ New Cloudflare Zone', zone_type: 'cloudflare' as const, isCreatePermission: true },
        ...(zonesResponse.zones || [])
      ];
      setAllZones(zonesWithCreatePermissions);

      // Check if user has API access enabled
      const hasApiAccess = apiResponse.tokens?.some(t => t.can_use_api) || false;
      setSelectedUserApiAccessEnabled(hasApiAccess);

      // Set Cloudflare accounts
      setCloudflareAccounts(accountsResponse.accounts || []);

      // Build map of assigned zones with their permissions
      const assignedMap = new Map<string, ZoneAssignment>();
      const accountsMap = new Map<number, any>();

      console.log('[openZoneAssignModal] Processing permissions:', permsResponse.permissions);

      (permsResponse.permissions || []).forEach(perm => {
        if (perm.permission_type === 'cloudflare_account') {
          // This is a Cloudflare account permission
          console.log('[openZoneAssignModal] Found Cloudflare account permission:', perm);
          accountsMap.set(perm.resource_id, {
            can_view: perm.can_view,
            can_add: perm.can_add,
            can_edit: perm.can_edit,
            can_delete: perm.can_delete,
            can_api_access: perm.can_api_access || false,
          });
        } else {
          // This is a zone permission
          const key = `${perm.zone_type}-${perm.zone_id === null ? 'new' : perm.zone_id}`;
          assignedMap.set(key, {
            zone_type: perm.zone_type,
            zone_id: perm.zone_id,
            can_view: perm.can_view,
            can_add: perm.can_add,
            can_edit: perm.can_edit,
            can_delete: perm.can_delete,
            can_api_access: perm.can_api_access || false,
          });
        }
      });

      console.log('[openZoneAssignModal] Loaded accountsMap:', Array.from(accountsMap.entries()));
      console.log('[openZoneAssignModal] Loaded assignedMap:', Array.from(assignedMap.entries()));

      setAssignedZones(assignedMap);
      setAssignedAccounts(accountsMap);
    } catch (error) {
      console.error("Failed to load zones:", error);
      toast.error("Failed to load zones");
    }
  }

  function moveZoneToAssigned(zone: Zone) {
    const key = `${zone.zone_type}-${zone.id === null ? 'new' : zone.id}`;
    if (!assignedZones.has(key)) {
      const newAssigned = new Map(assignedZones);
      newAssigned.set(key, {
        zone_type: zone.zone_type,
        zone_id: zone.id,
        can_view: true,
        can_add: true,
        can_edit: true,
        can_delete: true,
        can_api_access: true,
      });
      setAssignedZones(newAssigned);
      setSelectedZoneKey(key);
    }
  }

  function moveZoneToAvailable(zone: Zone) {
    const key = `${zone.zone_type}-${zone.id === null ? 'new' : zone.id}`;
    const newAssigned = new Map(assignedZones);
    newAssigned.delete(key);
    setAssignedZones(newAssigned);
    if (selectedZoneKey === key) {
      setSelectedZoneKey(null);
    }
  }

  function updateZonePermissions(key: string, permissions: Partial<ZoneAssignment>) {
    const existing = assignedZones.get(key);
    if (existing) {
      const newAssigned = new Map(assignedZones);
      newAssigned.set(key, { ...existing, ...permissions });
      setAssignedZones(newAssigned);
    }
  }

  async function saveZoneAssignments() {
    if (!selectedUserForZones) return;

    try {
      console.log('[saveZoneAssignments] Starting save for user:', selectedUserForZones.id);
      console.log('[saveZoneAssignments] Assigned zones:', Array.from(assignedZones.entries()));
      console.log('[saveZoneAssignments] Assigned accounts:', Array.from(assignedAccounts.entries()));

      // Get existing permissions to determine what to add/update/delete
      const response = await apiRequest<{ permissions: Permission[] }>(
        `/permissions/users/by-user/${selectedUserForZones.id}`
      );
      const existingPerms = response.permissions || [];

      // Separate zone permissions and account permissions
      const existingZonePerms = existingPerms.filter(p => p.permission_type !== 'cloudflare_account');
      const existingAccountPerms = existingPerms.filter(p => p.permission_type === 'cloudflare_account');

      const existingKeys = new Set(existingZonePerms.map(p => `${p.zone_type}-${p.zone_id}`));
      const assignedKeys = new Set(assignedZones.keys());

      const existingAccountIds = new Set(existingAccountPerms.map(p => p.resource_id));
      const assignedAccountIds = new Set(assignedAccounts.keys());

      console.log('[saveZoneAssignments] Existing zone keys:', Array.from(existingKeys));
      console.log('[saveZoneAssignments] Assigned zone keys:', Array.from(assignedKeys));
      console.log('[saveZoneAssignments] Existing account IDs:', Array.from(existingAccountIds));
      console.log('[saveZoneAssignments] Assigned account IDs:', Array.from(assignedAccountIds));

      // Delete removed zone permissions
      for (const perm of existingZonePerms) {
        const key = `${perm.zone_type}-${perm.zone_id}`;
        if (!assignedKeys.has(key)) {
          console.log('[saveZoneAssignments] Deleting zone permission:', key);
          await apiRequest(`/permissions/users/${perm.id}`, { method: "DELETE" });
        }
      }

      // Delete removed account permissions
      for (const perm of existingAccountPerms) {
        if (!assignedAccountIds.has(perm.resource_id)) {
          console.log('[saveZoneAssignments] Deleting account permission:', perm.resource_id);
          await apiRequest(`/permissions/users/${perm.id}`, { method: "DELETE" });
        }
      }

      // Add or update zone permissions
      console.log('[saveZoneAssignments] Processing', assignedZones.size, 'zone assignments');
      for (const [key, assignment] of assignedZones.entries()) {
        // Skip invalid assignments that don't have required zone fields
        if (!assignment.zone_type) {
          console.error('[saveZoneAssignments] Skipping invalid zone assignment (missing zone_type):', key, assignment);
          continue;
        }

        const payload = {
          user_id: selectedUserForZones.id,
          zone_type: assignment.zone_type,
          zone_id: assignment.zone_id ?? null,
          can_view: assignment.can_view ?? false,
          can_add: assignment.can_add ?? false,
          can_edit: assignment.can_edit ?? false,
          can_delete: assignment.can_delete ?? false,
          can_api_access: assignment.can_api_access ?? false,
        };
        console.log('[saveZoneAssignments] Sending zone permission:', payload);
        await apiRequest("/permissions/users/grant", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }

      // Add or update account permissions
      console.log('[saveZoneAssignments] Processing', assignedAccounts.size, 'account assignments');
      for (const [accountId, permissions] of assignedAccounts.entries()) {
        const payload = {
          user_id: selectedUserForZones.id,
          account_id: accountId,
          can_view: permissions.can_view ?? false,
          can_add: permissions.can_add ?? false,
          can_edit: permissions.can_edit ?? false,
          can_delete: permissions.can_delete ?? false,
          can_api_access: permissions.can_api_access ?? false,
        };
        console.log('[saveZoneAssignments] Sending account permission to /permissions/cloudflare-accounts/grant:', payload);
        await apiRequest("/permissions/cloudflare-accounts/grant", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }

      console.log('[saveZoneAssignments] Save completed successfully');
      toast.success("Zone and account assignments saved successfully");
      setShowZoneAssignModal(false);

      // Reload permissions if modal is open
      if (selectedUserForPerms && selectedUserForPerms.id === selectedUserForZones.id) {
        openPermissionsModal(selectedUserForPerms);
      }
    } catch (error) {
      console.error("[saveZoneAssignments] Failed to save:", error);
      const message = error instanceof Error ? error.message : "Failed to save assignments";
      toast.error(message);
    }
  }

  async function openPermissionsModal(user: User) {
    setSelectedUserForPerms(user);
    setShowPermissionsModal(true);

    // Load user permissions and API access status
    try {
      const [permsResponse, apiResponse] = await Promise.all([
        apiRequest<{ permissions: Permission[] }>(`/permissions/users/by-user/${user.id}`),
        apiRequest<{ tokens: ApiToken[] }>(`/permissions/api-access/${user.id}`)
      ]);

      setUserPermissions(permsResponse.permissions);
      const hasApiAccess = apiResponse.tokens?.some(t => t.can_use_api) || false;
      setUserApiAccessEnabled(hasApiAccess);
    } catch (error) {
      console.error("Failed to load permissions:", error);
      toast.error("Failed to load user permissions");
    }
  }

  async function handleRevokePermission(permissionId: number) {
    if (!confirm("Remove this zone access?")) return;

    try {
      await apiRequest(`/permissions/users/${permissionId}`, {
        method: "DELETE",
      });

      toast.success("Permission revoked");
      if (selectedUserForPerms) {
        openPermissionsModal(selectedUserForPerms);
      }
    } catch (error) {
      console.error("Failed to revoke permission:", error);
      const message = error instanceof Error ? error.message : "Failed to revoke permission";
      toast.error(message);
    }
  }

  async function handleToggleApiAccessInModal(userId: number, currentStatus: boolean) {
    try {
      await apiRequest(`/permissions/api-access/${userId}/enable`, {
        method: "POST",
        body: JSON.stringify({ enabled: !currentStatus }),
      });

      setUserApiAccessEnabled(!currentStatus);
      toast.success(`API access ${!currentStatus ? 'enabled' : 'disabled'}`);

      // Reload API tokens for user table if needed
      loadApiTokensForUser(userId);
    } catch (error) {
      console.error("Failed to toggle API access:", error);
      const message = error instanceof Error ? error.message : "Failed to toggle API access";
      toast.error(message);
    }
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <UnifiedHeader
        title="User Management"
        subtitle="Manage users, permissions, and audit logs"
        onLogout={onLogout}
        user={user}
      />

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
                        <TableHead>Managed By</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>API Access</TableHead>
                        <TableHead>Last Login</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {users.map((user) => {
                        const hasApiAccess = userApiTokens[user.id]?.some(t => t.can_use_api) || false;
                        return (
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
                            <TableCell className="text-sm">
                              {user.managed_by_username ? (
                                <span className="text-gray-700">{user.managed_by_username}</span>
                              ) : (
                                <span className="text-gray-400">-</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                                user.active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                              }`}>
                                {user.active ? "Active" : "Inactive"}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                variant={hasApiAccess ? "default" : "outline"}
                                onClick={() => handleToggleApiAccess(user.id, hasApiAccess)}
                              >
                                {hasApiAccess ? "Enabled" : "Disabled"}
                              </Button>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {user.last_login ? new Date(user.last_login).toLocaleString() : "Never"}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-2 flex-wrap">
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
                                  onClick={() => openZoneAssignModal(user)}
                                  className="text-green-600"
                                >
                                  Zones
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openPermissionsModal(user)}
                                  className="text-purple-600"
                                >
                                  Permissions
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
                        );
                      })}
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
                        <TableHead className="text-right">Actions</TableHead>
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
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleTerminateSession(session.id)}
                              className="text-red-600 hover:text-red-700"
                            >
                              Terminate
                            </Button>
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
                <CardTitle>Audit Logs</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Filter Section */}
                <div className="rounded-lg border bg-gray-50 p-4">
                  <h3 className="mb-3 text-sm font-semibold">Filters</h3>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <Label htmlFor="filter-date-from" className="text-xs">Date From</Label>
                      <Input
                        id="filter-date-from"
                        type="date"
                        value={logFilters.dateFrom}
                        onChange={(e) => setLogFilters({ ...logFilters, dateFrom: e.target.value })}
                        className="text-sm"
                      />
                    </div>
                    <div>
                      <Label htmlFor="filter-date-to" className="text-xs">Date To</Label>
                      <Input
                        id="filter-date-to"
                        type="date"
                        value={logFilters.dateTo}
                        onChange={(e) => setLogFilters({ ...logFilters, dateTo: e.target.value })}
                        className="text-sm"
                      />
                    </div>
                    <div className="relative">
                      <Label htmlFor="filter-user" className="text-xs">User</Label>
                      <Select
                        value={logFilters.user || "__all__"}
                        onValueChange={(value) => setLogFilters({ ...logFilters, user: value === "__all__" ? '' : value })}
                      >
                        <SelectTrigger id="filter-user" className="h-9 text-sm">
                          <SelectValue placeholder="All users" />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">
                          <div className="sticky top-0 bg-white p-2 border-b">
                            <Input
                              placeholder="Search users..."
                              value={userSearchQuery}
                              onChange={(e) => setUserSearchQuery(e.target.value)}
                              className="h-8 text-sm"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                          <SelectItem value="__all__">All users</SelectItem>
                          {users
                            .filter(u => u.username.toLowerCase().includes(userSearchQuery.toLowerCase()))
                            .map(user => (
                              <SelectItem key={user.id} value={user.username}>
                                {user.username}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="relative">
                      <Label htmlFor="filter-action" className="text-xs">Action</Label>
                      <Select
                        value={logFilters.action || "__all__"}
                        onValueChange={(value) => setLogFilters({ ...logFilters, action: value === "__all__" ? '' : value })}
                      >
                        <SelectTrigger id="filter-action" className="h-9 text-sm">
                          <SelectValue placeholder="All actions" />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">
                          <div className="sticky top-0 bg-white p-2 border-b">
                            <Input
                              placeholder="Search actions..."
                              value={actionSearchQuery}
                              onChange={(e) => setActionSearchQuery(e.target.value)}
                              className="h-8 text-sm"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                          <SelectItem value="__all__">All actions</SelectItem>
                          {[
                            { value: 'login', label: 'Login' },
                            { value: 'logout', label: 'Logout' },
                            { value: 'rr_create', label: 'Record Create' },
                            { value: 'rr_update', label: 'Record Update' },
                            { value: 'rr_delete', label: 'Record Delete' },
                            { value: 'soa_create', label: 'SOA Create' },
                            { value: 'soa_update', label: 'SOA Update' },
                            { value: 'soa_delete', label: 'SOA Delete' },
                            { value: 'user_create', label: 'User Create' },
                            { value: 'user_update', label: 'User Update' },
                            { value: 'user_delete', label: 'User Delete' },
                            { value: 'zone_create', label: 'Zone Create' },
                            { value: 'zone_update', label: 'Zone Update' },
                            { value: 'zone_delete', label: 'Zone Delete' },
                            { value: 'permission_grant', label: 'Permission Grant' },
                            { value: 'permission_revoke', label: 'Permission Revoke' },
                            { value: 'settings_update', label: 'Settings Update' },
                            { value: 'other', label: 'Other' }
                          ]
                            .filter(action => action.label.toLowerCase().includes(actionSearchQuery.toLowerCase()))
                            .map(action => (
                              <SelectItem key={action.value} value={action.value}>
                                {action.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="relative">
                      <Label htmlFor="filter-domain" className="text-xs">Domain</Label>
                      <Select
                        value={logFilters.domain || "__all__"}
                        onValueChange={(value) => setLogFilters({ ...logFilters, domain: value === "__all__" ? '' : value })}
                      >
                        <SelectTrigger id="filter-domain" className="h-9 text-sm">
                          <SelectValue placeholder="All domains" />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">
                          <div className="sticky top-0 bg-white p-2 border-b">
                            <Input
                              placeholder="Search domains..."
                              value={domainSearchQuery}
                              onChange={(e) => setDomainSearchQuery(e.target.value)}
                              className="h-8 text-sm"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                          <SelectItem value="__all__">All domains</SelectItem>
                          {allDomains
                            .filter(domain => domain.toLowerCase().includes(domainSearchQuery.toLowerCase()))
                            .map(domain => (
                              <SelectItem key={domain} value={domain}>
                                {domain}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="filter-ip" className="text-xs">IP Address</Label>
                      <Input
                        id="filter-ip"
                        type="text"
                        placeholder="Search IP..."
                        value={logFilters.ipAddress}
                        onChange={(e) => setLogFilters({ ...logFilters, ipAddress: e.target.value })}
                        className="text-sm"
                      />
                    </div>
                    <div>
                      <Label htmlFor="filter-description" className="text-xs">Description</Label>
                      <Input
                        id="filter-description"
                        type="text"
                        placeholder="Search description..."
                        value={logFilters.description}
                        onChange={(e) => setLogFilters({ ...logFilters, description: e.target.value })}
                        className="text-sm"
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button onClick={applyFilters} size="sm">Apply Filters</Button>
                    <Button onClick={clearFilters} variant="outline" size="sm">Clear Filters</Button>
                  </div>
                </div>

                {/* Results count and per-page selector */}
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-600">
                    Showing {logs.length > 0 ? ((logPage - 1) * logPerPage + 1) : 0} to {Math.min(logPage * logPerPage, logTotalCount)} of {logTotalCount} results
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="per-page" className="text-xs whitespace-nowrap">Results per page:</Label>
                    <Select
                      value={logPerPage.toString()}
                      onValueChange={(value) => {
                        setLogPerPage(Number(value));
                        setLogPage(1);
                      }}
                    >
                      <SelectTrigger id="per-page" className="w-20 h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="15">15</SelectItem>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Table */}
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>User</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>IP Address</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {logs.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-gray-500 py-8">
                            No audit logs found
                          </TableCell>
                        </TableRow>
                      ) : (
                        logs.map((log) => (
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
                                (log.action_type === "other" && log.description.includes("Restored")) ? "bg-yellow-100 text-yellow-700" :
                                log.action_type === "other" ? "bg-gray-100 text-gray-700" :
                                "bg-gray-100 text-gray-700"
                              }`}>
                                {(log.action_type === "other" && log.description.includes("Restored"))
                                  ? "Restore"
                                  : log.action_type
                                    .replace('rr_', 'Record ')
                                    .replace('soa_', 'SOA ')
                                    .replace('user_', 'User ')
                                    .replace('zone_', 'Zone ')
                                    .replace('lb_', 'LB ')
                                    .replace('pool_', 'Pool ')
                                    .replace('permission_', 'Permission ')
                                    .replace('settings_', 'Settings ')
                                    .replace('_', ' ')
                                    .split(' ')
                                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                                    .join(' ')
                                }
                              </span>
                            </TableCell>
                            <TableCell className="max-w-md truncate text-sm">{log.description}</TableCell>
                            <TableCell className="font-mono text-sm">{log.ip_address}</TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-2">
                                {log.action_type === 'rr_delete' && log.resource_type === 'dns_record' && log.resource_id ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleRestoreRecord(log.id)}
                                    disabled={log.isRestored}
                                    className="text-xs"
                                    title={log.isRestored ? "This record has already been restored" : "Restore this deleted record"}
                                  >
                                    {log.isRestored ? "Restored" : "Undo"}
                                  </Button>
                                ) : log.resource_id && !log.action_type.includes('delete') && !log.action_type.includes('login') ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleViewRecord(log)}
                                    className="text-xs"
                                  >
                                    View
                                  </Button>
                                ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between">
                  <Button
                    onClick={() => setLogPage(p => Math.max(1, p - 1))}
                    disabled={logPage === 1}
                    variant="outline"
                    size="sm"
                  >
                    Previous
                  </Button>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600">
                      Page {logPage} of {Math.ceil(logTotalCount / logPerPage) || 1}
                    </span>
                  </div>
                  <Button
                    onClick={() => setLogPage(p => p + 1)}
                    disabled={logPage >= Math.ceil(logTotalCount / logPerPage)}
                    variant="outline"
                    size="sm"
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Add User Modal */}
      {showAddUserModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-lg max-h-[90vh] overflow-y-auto">
            <h2 className="mb-4 text-lg font-semibold">Add New User</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
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
              </div>

              <div className="grid grid-cols-2 gap-4">
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
              </div>

              <div className="grid grid-cols-2 gap-4">
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
                <div>
                  <Label htmlFor="new-user-managed-by">Managed By</Label>
                  <select
                    id="new-user-managed-by"
                    className="w-full rounded-md border px-3 py-2"
                    value={newUser.managed_by || ""}
                    onChange={(e) => setNewUser({ ...newUser, managed_by: e.target.value ? Number(e.target.value) : null })}
                  >
                    <option value="">-- None --</option>
                    {accountAdmins.map(admin => (
                      <option key={admin.id} value={admin.id}>
                        {admin.username} ({admin.role})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="border-t pt-4">
                <h3 className="font-medium mb-3">Two-Factor Authentication</h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="new-user-require-2fa"
                      checked={newUser.require_2fa}
                      onChange={(e) => setNewUser({ ...newUser, require_2fa: e.target.checked })}
                    />
                    <Label htmlFor="new-user-require-2fa" className="cursor-pointer">
                      Require 2FA
                    </Label>
                  </div>

                  {newUser.require_2fa && (
                    <>
                      <div>
                        <Label htmlFor="new-user-twofa-method">2FA Method</Label>
                        <select
                          id="new-user-twofa-method"
                          className="w-full rounded-md border px-3 py-2"
                          value={newUser.twofa_method}
                          onChange={(e) => setNewUser({ ...newUser, twofa_method: e.target.value as any })}
                        >
                          <option value="none">None</option>
                          <option value="email">Email</option>
                          <option value="sms">SMS</option>
                        </select>
                      </div>

                      {newUser.twofa_method && newUser.twofa_method !== 'none' && (
                        <div>
                          <Label htmlFor="new-user-twofa-contact">2FA Contact ({newUser.twofa_method === 'email' ? 'Email' : 'Phone'})</Label>
                          <Input
                            id="new-user-twofa-contact"
                            type={newUser.twofa_method === 'email' ? 'email' : 'tel'}
                            value={newUser.twofa_contact}
                            onChange={(e) => setNewUser({ ...newUser, twofa_contact: e.target.value })}
                            placeholder={newUser.twofa_method === 'email' ? 'user@example.com' : '+1234567890'}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 border-t pt-4">
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
                      require_2fa: false,
                      twofa_method: "none",
                      twofa_contact: "",
                      managed_by: null,
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
          <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-lg max-h-[90vh] overflow-y-auto">
            <h2 className="mb-4 text-lg font-semibold">Edit User</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
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
              </div>

              <div className="grid grid-cols-2 gap-4">
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
              </div>

              <div>
                <Label htmlFor="edit-user-managed-by">Managed By</Label>
                <select
                  id="edit-user-managed-by"
                  className="w-full rounded-md border px-3 py-2"
                  value={editingUser.managed_by || ""}
                  onChange={(e) => setEditingUser({ ...editingUser, managed_by: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">-- None (Managed by Superadmin) --</option>
                  {accountAdmins.filter(admin => admin.id !== editingUser.id).map(admin => (
                    <option key={admin.id} value={admin.id}>
                      {admin.username} ({admin.role})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  {editingUser.role === 'user' ? 'Assign this user to an account admin' : 'Only applies to regular users'}
                </p>
              </div>

              <div className="border-t pt-4">
                <h3 className="font-medium mb-3">Two-Factor Authentication</h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="edit-user-require-2fa"
                      checked={Boolean(editingUser.require_2fa)}
                      onChange={(e) => setEditingUser({ ...editingUser, require_2fa: e.target.checked ? 1 : 0 })}
                    />
                    <Label htmlFor="edit-user-require-2fa" className="cursor-pointer">
                      Require 2FA
                    </Label>
                  </div>

                  {Boolean(editingUser.require_2fa) && (
                    <>
                      <div>
                        <Label htmlFor="edit-user-twofa-method">2FA Method</Label>
                        <select
                          id="edit-user-twofa-method"
                          className="w-full rounded-md border px-3 py-2"
                          value={editingUser.twofa_method || 'none'}
                          onChange={(e) => setEditingUser({ ...editingUser, twofa_method: e.target.value as any })}
                        >
                          <option value="none">None</option>
                          <option value="email">Email</option>
                          <option value="sms">SMS</option>
                        </select>
                      </div>

                      {editingUser.twofa_method && editingUser.twofa_method !== 'none' && (
                        <div>
                          <Label htmlFor="edit-user-twofa-contact">2FA Contact ({editingUser.twofa_method === 'email' ? 'Email' : 'Phone'})</Label>
                          <Input
                            id="edit-user-twofa-contact"
                            type={editingUser.twofa_method === 'email' ? 'email' : 'tel'}
                            value={editingUser.twofa_contact || ""}
                            onChange={(e) => setEditingUser({ ...editingUser, twofa_contact: e.target.value })}
                            placeholder={editingUser.twofa_method === 'email' ? 'user@example.com' : '+1234567890'}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 border-t pt-4">
                <input
                  type="checkbox"
                  id="edit-user-active"
                  checked={Boolean(editingUser.active)}
                  onChange={(e) => setEditingUser({ ...editingUser, active: e.target.checked ? 1 : 0 })}
                />
                <Label htmlFor="edit-user-active" className="cursor-pointer">
                  Active
                </Label>
                <span className="text-xs text-gray-500 ml-2">(Unchecking will terminate all sessions)</span>
              </div>

              <div className="flex justify-between items-center gap-2 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setUserToResetPassword(editingUser);
                    setShowResetPasswordModal(true);
                  }}
                  className="text-orange-600"
                >
                  Reset Password
                </Button>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setEditingUser(null)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() =>
                      handleUpdateUser(editingUser.id, {
                        email: editingUser.email,
                        full_name: editingUser.full_name,
                        role: editingUser.role,
                        active: Boolean(editingUser.active),
                        require_2fa: Boolean(editingUser.require_2fa),
                        twofa_method: editingUser.twofa_method,
                        twofa_contact: editingUser.twofa_contact,
                        managed_by: editingUser.managed_by,
                      })
                    }
                  >
                    Update User
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Zone Assignment Modal */}
      {showZoneAssignModal && selectedUserForZones && (() => {
        const availableZones = allZones.filter(z => {
          const key = `${z.zone_type}-${z.id === null ? 'new' : z.id}`;
          const matchesType = zoneTypeFilter === 'all' || z.zone_type === zoneTypeFilter;
          const matchesSearch = !searchAvailable || z.origin.toLowerCase().includes(searchAvailable.toLowerCase());
          return !assignedZones.has(key) && matchesType && matchesSearch;
        });

        const assignedZonesList = Array.from(assignedZones.entries()).map(([key, assignment]) => {
          const zone = allZones.find(z => `${z.zone_type}-${z.id === null ? 'new' : z.id}` === key);
          return zone ? { ...zone, assignment } : null;
        }).filter(z => z !== null && (!searchAssigned || z.origin.toLowerCase().includes(searchAssigned.toLowerCase())));

        const selectedZone = selectedZoneKey ? assignedZones.get(selectedZoneKey) : null;
        const selectedZoneInfo = selectedZoneKey ? allZones.find(z => `${z.zone_type}-${z.id === null ? 'new' : z.id}` === selectedZoneKey) : null;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <Card className="w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
              <CardHeader>
                <CardTitle>Manage Zones for {selectedUserForZones.username}</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 overflow-y-auto flex flex-col">
                {/* Cloudflare Account Assignment Section */}
                {cloudflareAccounts.length > 0 && (
                  <div className="mb-4 border rounded-lg overflow-hidden flex-shrink-0">
                    <div
                      className="p-4 bg-orange-50 cursor-pointer hover:bg-orange-100 flex items-center justify-between"
                      onClick={() => setExpandedSection(expandedSection === 'accounts' ? 'zones' : 'accounts')}
                    >
                      <div>
                        <h3 className="font-bold text-base">Cloudflare Account Access</h3>
                        <p className="text-xs text-gray-600 mt-1">
                          Assign entire Cloudflare accounts (includes all zones in the account)
                        </p>
                      </div>
                      <span className="text-lg font-bold">
                        {expandedSection === 'accounts' ? '−' : '+'}
                      </span>
                    </div>
                    {expandedSection === 'accounts' && (
                      <div className="p-4 bg-white border-t space-y-2 max-h-96 overflow-y-auto">
                      {cloudflareAccounts.map(account => {
                        const isAssigned = assignedAccounts.has(account.id);
                        const permissions = assignedAccounts.get(account.id);

                        return (
                          <div key={account.id} className="border rounded bg-white p-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <Checkbox
                                  checked={isAssigned}
                                  onCheckedChange={(checked) => {
                                    console.log('Account checkbox changed:', account.id, checked);
                                    const newAssigned = new Map(assignedAccounts);
                                    if (checked) {
                                      newAssigned.set(account.id, {
                                        can_view: true,
                                        can_add: true,
                                        can_edit: true,
                                        can_delete: true,
                                        can_api_access: true,
                                      });
                                    } else {
                                      newAssigned.delete(account.id);
                                    }
                                    console.log('Updated assignedAccounts:', Array.from(newAssigned.entries()));
                                    setAssignedAccounts(newAssigned);
                                  }}
                                />
                                <div>
                                  <div className="font-medium text-sm">{account.name}</div>
                                  <div className="text-xs text-gray-500">{account.cf_account_id}</div>
                                </div>
                              </div>
                              {isAssigned && (
                                <span className="text-xs px-2 py-1 rounded bg-orange-100 text-orange-700">
                                  Assigned
                                </span>
                              )}
                            </div>
                            {isAssigned && permissions && (
                              <div className="flex gap-4 ml-6 mt-2 pt-2 border-t">
                                <label className="flex items-center gap-1 text-xs cursor-pointer">
                                  <Checkbox
                                    checked={permissions.can_view}
                                    onCheckedChange={(checked) => {
                                      const newAssigned = new Map(assignedAccounts);
                                      newAssigned.set(account.id, { ...permissions, can_view: !!checked });
                                      setAssignedAccounts(newAssigned);
                                    }}
                                  />
                                  View
                                </label>
                                <label className="flex items-center gap-1 text-xs cursor-pointer">
                                  <Checkbox
                                    checked={permissions.can_add}
                                    onCheckedChange={(checked) => {
                                      const newAssigned = new Map(assignedAccounts);
                                      newAssigned.set(account.id, { ...permissions, can_add: !!checked });
                                      setAssignedAccounts(newAssigned);
                                    }}
                                  />
                                  Add
                                </label>
                                <label className="flex items-center gap-1 text-xs cursor-pointer">
                                  <Checkbox
                                    checked={permissions.can_edit}
                                    onCheckedChange={(checked) => {
                                      const newAssigned = new Map(assignedAccounts);
                                      newAssigned.set(account.id, { ...permissions, can_edit: !!checked });
                                      setAssignedAccounts(newAssigned);
                                    }}
                                  />
                                  Edit
                                </label>
                                <label className="flex items-center gap-1 text-xs cursor-pointer">
                                  <Checkbox
                                    checked={permissions.can_delete}
                                    onCheckedChange={(checked) => {
                                      const newAssigned = new Map(assignedAccounts);
                                      newAssigned.set(account.id, { ...permissions, can_delete: !!checked });
                                      setAssignedAccounts(newAssigned);
                                    }}
                                  />
                                  Delete
                                </label>
                                {selectedUserApiAccessEnabled && (
                                  <label className="flex items-center gap-1 text-xs cursor-pointer">
                                    <Checkbox
                                      checked={permissions.can_api_access}
                                      onCheckedChange={(checked) => {
                                        const newAssigned = new Map(assignedAccounts);
                                        newAssigned.set(account.id, { ...permissions, can_api_access: !!checked });
                                        setAssignedAccounts(newAssigned);
                                      }}
                                    />
                                    API Access
                                  </label>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      </div>
                    )}
                  </div>
                )}

                {/* Individual Zone Assignment Section */}
                <div className="flex-1 border rounded-lg overflow-hidden flex flex-col">
                  <div
                    className="p-4 bg-blue-50 cursor-pointer hover:bg-blue-100 flex items-center justify-between"
                    onClick={() => setExpandedSection(expandedSection === 'zones' ? 'accounts' : 'zones')}
                  >
                    <div>
                      <h3 className="font-bold text-base">Individual Zone Assignment</h3>
                      <p className="text-xs text-gray-600 mt-1">
                        Assign specific zones with granular permissions
                      </p>
                    </div>
                    <span className="text-lg font-bold">
                      {expandedSection === 'zones' ? '−' : '+'}
                    </span>
                  </div>

                  {expandedSection === 'zones' && (
                    <div className="flex-1 flex flex-col overflow-hidden">
                      {/* Zone Type Filter */}
                      <div className="p-4 border-b bg-white">
                        <Label>Filter by Zone Type</Label>
                        <Select
                          value={zoneTypeFilter}
                          onValueChange={(value) => setZoneTypeFilter(value as any)}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Zones</SelectItem>
                            <SelectItem value="soa">SOA (MyDNS)</SelectItem>
                            <SelectItem value="cloudflare">Cloudflare</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="flex-1 grid grid-cols-[2fr,60px,2fr,1.7fr] gap-4 p-4 min-h-0">
                  {/* Available Zones */}
                  <div className="flex flex-col min-h-0">
                    <Label className="mb-2">Available Zones</Label>
                    <Input
                      placeholder="Search..."
                      value={searchAvailable}
                      onChange={(e) => setSearchAvailable(e.target.value)}
                      className="mb-2"
                    />
                    <div className="border rounded flex-1 overflow-y-auto">
                      {availableZones.map(zone => (
                        <div
                          key={`${zone.zone_type}-${zone.id === null ? 'new' : zone.id}`}
                          className={`p-2 hover:bg-gray-100 cursor-pointer border-b flex justify-between items-center ${
                            zone.isCreatePermission ? 'bg-green-50' : ''
                          }`}
                          onClick={() => moveZoneToAssigned(zone)}
                        >
                          <span className={`text-sm ${zone.isCreatePermission ? 'font-semibold' : ''}`}>
                            {zone.origin}
                          </span>
                          <span className={`text-xs px-2 py-1 rounded ${
                            zone.zone_type === 'soa' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                          }`}>
                            {zone.zone_type === 'soa' ? 'SOA' : 'CF'}
                          </span>
                        </div>
                      ))}
                      {availableZones.length === 0 && (
                        <div className="p-4 text-center text-gray-500 text-sm">
                          No available zones
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Move Buttons */}
                  <div className="flex flex-col justify-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      className="w-12"
                    >
                      →
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      className="w-12"
                    >
                      ←
                    </Button>
                  </div>

                  {/* Assigned Zones */}
                  <div className="flex flex-col min-h-0">
                    <Label className="mb-2">Assigned Zones</Label>
                    <Input
                      placeholder="Search..."
                      value={searchAssigned}
                      onChange={(e) => setSearchAssigned(e.target.value)}
                      className="mb-2"
                    />
                    <div className="border rounded flex-1 overflow-y-auto">
                      {assignedZonesList.map(item => {
                        const key = `${item.zone_type}-${item.id === null ? 'new' : item.id}`;
                        return (
                          <div
                            key={key}
                            className={`p-2 cursor-pointer border-b flex justify-between items-center ${
                              selectedZoneKey === key ? 'bg-blue-50' : 'hover:bg-gray-100'
                            } ${item.isCreatePermission ? 'bg-green-50' : ''}`}
                            onClick={() => setSelectedZoneKey(key)}
                          >
                            <span className={`text-sm ${item.isCreatePermission ? 'font-semibold' : ''}`}>
                              {item.origin}
                            </span>
                            <div className="flex items-center gap-2">
                              <span className={`text-xs px-2 py-1 rounded ${
                                item.zone_type === 'soa' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                              }`}>
                                {item.zone_type === 'soa' ? 'SOA' : 'CF'}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  moveZoneToAvailable(item);
                                }}
                                className="h-6 w-6 p-0"
                              >
                                ×
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                      {assignedZonesList.length === 0 && (
                        <div className="p-4 text-center text-gray-500 text-sm">
                          No assigned zones
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Permissions Panel */}
                  <div className="flex flex-col min-h-0">
                    <Label className="mb-2">Permissions</Label>
                    <div className="border rounded flex-1 p-4">
                      {selectedZone && selectedZoneInfo ? (
                        <div className="space-y-4">
                          <div className="pb-2 border-b">
                            <div className="font-medium text-sm truncate" title={selectedZoneInfo.origin}>
                              {selectedZoneInfo.origin.length > 20
                                ? selectedZoneInfo.origin.substring(0, 20) + '...'
                                : selectedZoneInfo.origin}
                            </div>
                            <div className="text-xs text-gray-500">{selectedZone.zone_type === 'soa' ? 'SOA Zone' : 'Cloudflare Zone'}</div>
                          </div>
                          <div className="space-y-3">
                            <div className="flex items-center space-x-2">
                              <Checkbox
                                id="perm-view-selected"
                                checked={selectedZone.can_view}
                                onCheckedChange={(checked) => updateZonePermissions(selectedZoneKey!, { can_view: !!checked })}
                              />
                              <label htmlFor="perm-view-selected" className="text-sm font-medium cursor-pointer">
                                View
                              </label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <Checkbox
                                id="perm-add-selected"
                                checked={selectedZone.can_add}
                                onCheckedChange={(checked) => updateZonePermissions(selectedZoneKey!, { can_add: !!checked })}
                              />
                              <label htmlFor="perm-add-selected" className="text-sm font-medium cursor-pointer">
                                Add
                              </label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <Checkbox
                                id="perm-edit-selected"
                                checked={selectedZone.can_edit}
                                onCheckedChange={(checked) => updateZonePermissions(selectedZoneKey!, { can_edit: !!checked })}
                              />
                              <label htmlFor="perm-edit-selected" className="text-sm font-medium cursor-pointer">
                                Edit
                              </label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <Checkbox
                                id="perm-delete-selected"
                                checked={selectedZone.can_delete}
                                onCheckedChange={(checked) => updateZonePermissions(selectedZoneKey!, { can_delete: !!checked })}
                              />
                              <label htmlFor="perm-delete-selected" className="text-sm font-medium cursor-pointer">
                                Delete
                              </label>
                            </div>
                            {selectedUserApiAccessEnabled && (
                              <div className="flex items-center space-x-2 pt-2 border-t">
                                <Checkbox
                                  id="perm-api-selected"
                                  checked={selectedZone.can_api_access}
                                  onCheckedChange={(checked) => updateZonePermissions(selectedZoneKey!, { can_api_access: !!checked })}
                                />
                                <label htmlFor="perm-api-selected" className="text-sm font-medium cursor-pointer">
                                  API Access
                                </label>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center h-full text-center text-gray-500 text-sm">
                          Select a zone to manage permissions
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

                <div className="flex gap-2 justify-end mt-4">
                  <Button variant="outline" onClick={() => setShowZoneAssignModal(false)}>
                    Cancel
                  </Button>
                  <Button onClick={saveZoneAssignments}>Save Assignments</Button>
                </div>
              </CardContent>
            </Card>
          </div>
        );
      })()}

      {/* Permissions Management Modal */}
      {showPermissionsModal && selectedUserForPerms && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <CardHeader>
              <div className="flex justify-between items-center">
                <CardTitle>Manage Permissions for {selectedUserForPerms.username}</CardTitle>
                <Button variant="outline" onClick={() => openZoneAssignModal(selectedUserForPerms)}>
                  Add Zone
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto space-y-6">
              {/* API Access Section */}
              <div className="border rounded-lg p-4 bg-gray-50">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-sm">API Access</h3>
                    <p className="text-xs text-gray-500 mt-1">
                      Allow this user to create and use API tokens
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={userApiAccessEnabled ? "default" : "outline"}
                    onClick={() => handleToggleApiAccessInModal(selectedUserForPerms.id, userApiAccessEnabled)}
                  >
                    {userApiAccessEnabled ? "Enabled" : "Disabled"}
                  </Button>
                </div>
              </div>

              {/* Zone Permissions Section */}
              <div>
                <h3 className="font-semibold text-sm mb-3">Zone Permissions</h3>
                {!userPermissions || userPermissions.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No zone permissions assigned yet. Click "Add Zone" to get started.
                  </div>
                ) : (
                  <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Zone Type</TableHead>
                      <TableHead>Zone Name</TableHead>
                      <TableHead>View</TableHead>
                      <TableHead>Add</TableHead>
                      <TableHead>Edit</TableHead>
                      <TableHead>Delete</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {userPermissions.map((perm) => (
                      <TableRow key={perm.id}>
                        <TableCell>
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                            perm.zone_type === 'soa' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                          }`}>
                            {perm.zone_type === 'soa' ? 'SOA' : 'Cloudflare'}
                          </span>
                        </TableCell>
                        <TableCell className="font-medium">{perm.zone_name}</TableCell>
                        <TableCell>{perm.can_view ? '✓' : '-'}</TableCell>
                        <TableCell>{perm.can_add ? '✓' : '-'}</TableCell>
                        <TableCell>{perm.can_edit ? '✓' : '-'}</TableCell>
                        <TableCell>{perm.can_delete ? '✓' : '-'}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleRevokePermission(perm.id)}
                          >
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                )}
              </div>

              <div className="flex justify-end mt-4">
                <Button variant="outline" onClick={() => setShowPermissionsModal(false)}>
                  Close
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Delete User Confirmation Modal */}
      {showDeleteModal && userToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-red-600">Delete User</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-red-50 border border-red-200 rounded p-4">
                <p className="text-sm text-red-800 font-semibold mb-2">⚠️ Warning: This action cannot be undone!</p>
                <p className="text-sm text-red-700">
                  You are about to permanently delete user <strong>{userToDelete.username}</strong>.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="delete-confirm">
                  Type <strong>{userToDelete.username}</strong> to confirm deletion:
                </Label>
                <Input
                  id="delete-confirm"
                  type="text"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder={userToDelete.username}
                  className="font-mono"
                />
              </div>

              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowDeleteModal(false);
                    setUserToDelete(null);
                    setDeleteConfirmText('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={confirmDeleteUser}
                  disabled={deleteConfirmText !== userToDelete.username}
                >
                  Delete User
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Reset Password Modal */}
      {showResetPasswordModal && userToResetPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Reset Password for {userToResetPassword.username}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="new-password">New Password *</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  minLength={6}
                />
                <p className="text-xs text-gray-500 mt-1">Minimum 6 characters</p>
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded p-3">
                <p className="text-sm text-yellow-800">
                  <strong>Warning:</strong> This will reset the user's password and terminate all their active sessions.
                </p>
              </div>

              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowResetPasswordModal(false);
                    setUserToResetPassword(null);
                    setNewPassword("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleResetPassword}
                  disabled={!newPassword || newPassword.length < 6}
                >
                  Reset Password
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <ToastContainer />
    </div>
  );
}
