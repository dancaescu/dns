import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import { apiRequest } from "../lib/api";
import { toast } from "../components/ui/toast";

interface Zone {
  id: number;
  name: string;
  zone_type: 'soa' | 'cloudflare';
  account_id: number | null;
  user_id: number | null;
  assignments: any[];
}

interface Account {
  id: number;
  name: string;
}

export function ZoneAssignments() {
  const [soaZones, setSoaZones] = useState<Zone[]>([]);
  const [cfZones, setCfZones] = useState<Zone[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);
  const [assignmentForm, setAssignmentForm] = useState({
    account_id: "",
    can_view: true,
    can_add: false,
    can_edit: false,
    can_delete: false,
  });
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    loadZones();
    loadAccounts();
  }, []);

  async function loadZones() {
    try {
      const response = await apiRequest<{ soa_zones: Zone[]; cloudflare_zones: Zone[] }>("/permissions/zones");
      setSoaZones(response.soa_zones);
      setCfZones(response.cloudflare_zones);
    } catch (error) {
      console.error("Failed to load zones:", error);
      toast({ title: "Error", description: "Failed to load zones", variant: "destructive" });
    }
  }

  async function loadAccounts() {
    try {
      // Assuming there's an endpoint to get accounts
      const response = await apiRequest<{ accounts: Account[] }>("/users/accounts");
      setAccounts(response.accounts || []);
    } catch (error) {
      console.error("Failed to load accounts:", error);
    }
  }

  async function handleAssignZone() {
    if (!selectedZone || !assignmentForm.account_id) {
      toast({ title: "Error", description: "Please select an account", variant: "destructive" });
      return;
    }

    try {
      await apiRequest("/permissions/zones/assign", {
        method: "POST",
        body: JSON.stringify({
          zone_type: selectedZone.zone_type,
          zone_id: selectedZone.id,
          account_id: parseInt(assignmentForm.account_id),
          can_view: assignmentForm.can_view,
          can_add: assignmentForm.can_add,
          can_edit: assignmentForm.can_edit,
          can_delete: assignmentForm.can_delete,
        }),
      });

      toast({ title: "Success", description: "Zone assigned successfully" });
      setShowAssignModal(false);
      setSelectedZone(null);
      setAssignmentForm({
        account_id: "",
        can_view: true,
        can_add: false,
        can_edit: false,
        can_delete: false,
      });
      loadZones();
    } catch (error) {
      console.error("Failed to assign zone:", error);
      toast({ title: "Error", description: "Failed to assign zone", variant: "destructive" });
    }
  }

  async function handleRemoveAssignment(zone: Zone, accountId: number) {
    if (!confirm("Remove this zone assignment?")) return;

    try {
      await apiRequest("/permissions/zones/assign", {
        method: "DELETE",
        body: JSON.stringify({
          zone_type: zone.zone_type,
          zone_id: zone.id,
          account_id: accountId,
        }),
      });

      toast({ title: "Success", description: "Assignment removed" });
      loadZones();
    } catch (error) {
      console.error("Failed to remove assignment:", error);
      toast({ title: "Error", description: "Failed to remove assignment", variant: "destructive" });
    }
  }

  function openAssignModal(zone: Zone) {
    setSelectedZone(zone);
    setShowAssignModal(true);
  }

  function filterZones(zones: Zone[]) {
    if (!searchTerm) return zones;
    return zones.filter(z => z.name.toLowerCase().includes(searchTerm.toLowerCase()));
  }

  function renderZoneTable(zones: Zone[], zoneType: string) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Zone Name</TableHead>
            <TableHead>Owner Account</TableHead>
            <TableHead>Assignments</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filterZones(zones).map((zone) => (
            <TableRow key={zone.id}>
              <TableCell className="font-medium">{zone.name}</TableCell>
              <TableCell>{zone.account_id || "N/A"}</TableCell>
              <TableCell>
                {zone.assignments && zone.assignments.length > 0 ? (
                  <div className="space-y-1">
                    {zone.assignments.map((assignment: any, idx: number) => (
                      <div key={idx} className="flex items-center gap-2 text-sm">
                        <span>Account {assignment.account_id}</span>
                        <span className="text-xs text-gray-500">
                          [{assignment.can_view ? "V" : "-"}
                          {assignment.can_add ? "A" : "-"}
                          {assignment.can_edit ? "E" : "-"}
                          {assignment.can_delete ? "D" : "-"}]
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleRemoveAssignment(zone, assignment.account_id)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-gray-500">No assignments</span>
                )}
              </TableCell>
              <TableCell>
                <Button size="sm" onClick={() => openAssignModal(zone)}>
                  Assign
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Zone Assignments</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Search Zones</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            placeholder="Search by zone name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </CardContent>
      </Card>

      <Tabs defaultValue="soa">
        <TabsList>
          <TabsTrigger value="soa">SOA Zones ({soaZones.length})</TabsTrigger>
          <TabsTrigger value="cloudflare">Cloudflare Zones ({cfZones.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="soa">
          <Card>
            <CardHeader>
              <CardTitle>SOA Zones</CardTitle>
            </CardHeader>
            <CardContent>
              {renderZoneTable(soaZones, "soa")}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cloudflare">
          <Card>
            <CardHeader>
              <CardTitle>Cloudflare Zones</CardTitle>
            </CardHeader>
            <CardContent>
              {renderZoneTable(cfZones, "cloudflare")}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Assign Zone Modal */}
      {showAssignModal && selectedZone && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Assign Zone: {selectedZone.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Account</Label>
                <Select
                  value={assignmentForm.account_id}
                  onValueChange={(value) => setAssignmentForm({ ...assignmentForm, account_id: value })}
                >
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
              </div>

              <div className="space-y-2">
                <Label>Permissions</Label>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="can_view"
                    checked={assignmentForm.can_view}
                    onCheckedChange={(checked) =>
                      setAssignmentForm({ ...assignmentForm, can_view: checked as boolean })
                    }
                  />
                  <label htmlFor="can_view" className="text-sm">
                    View
                  </label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="can_add"
                    checked={assignmentForm.can_add}
                    onCheckedChange={(checked) =>
                      setAssignmentForm({ ...assignmentForm, can_add: checked as boolean })
                    }
                  />
                  <label htmlFor="can_add" className="text-sm">
                    Add
                  </label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="can_edit"
                    checked={assignmentForm.can_edit}
                    onCheckedChange={(checked) =>
                      setAssignmentForm({ ...assignmentForm, can_edit: checked as boolean })
                    }
                  />
                  <label htmlFor="can_edit" className="text-sm">
                    Edit
                  </label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="can_delete"
                    checked={assignmentForm.can_delete}
                    onCheckedChange={(checked) =>
                      setAssignmentForm({ ...assignmentForm, can_delete: checked as boolean })
                    }
                  />
                  <label htmlFor="can_delete" className="text-sm">
                    Delete
                  </label>
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowAssignModal(false)}>
                  Cancel
                </Button>
                <Button onClick={handleAssignZone}>Assign</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
