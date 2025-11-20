import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import {
  apiRequest,
  createCloudflareRecord,
  deleteCloudflareRecord,
  getCloudflareZone,
  getCloudflareZoneRecords,
  getCloudflareZoneLoadBalancers,
  syncCloudflareZone,
  updateCloudflareRecord,
  createCloudflareLoadBalancer,
  updateCloudflareLoadBalancer,
  deleteCloudflareLoadBalancer,
  getLoadBalancerPools,
  getPool,
} from "../lib/api";
import { RECORD_TYPE_LIST, RECORD_TYPES, TTL_OPTIONS, getTTLLabel } from "../lib/recordTypes";
import { toast, ToastContainer } from "../components/ui/toast";
import { TagInput } from "../components/ui/tag-input";
import { SyncModal, SyncMode } from "../components/SyncModal";
import { LoadBalancerEditor } from "../components/LoadBalancerEditor";

type CloudflareZoneDetail = {
  id: number;
  name: string;
  account_name: string | null;
  cf_account_id: string | null;
  status: string | null;
  plan_name: string | null;
};

type CloudflareRecord = {
  id: number;
  record_type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: number;
  priority?: number;
  comment?: string | null;
  tags?: string | null;
};

type CloudflareLoadBalancer = {
  id: number;
  cf_lb_id: string;
  name: string;
  proxied: number | null;
  enabled: number | null;
  fallback_pool: string | null;
  default_pools: string | null;
  steering_policy: string | null;
};

type SoaRecord = {
  id: number;
  origin: string;
  ns: string;
  mbox: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
  ttl: number;
  active: "Y" | "N";
};

const defaultRecordForm = {
  type: "A",
  name: "",
  content: "",
  ttl: 300,
  proxied: false,
  priority: 0,
  weight: 0,
  port: 0,
  comment: "",
  tags: "",
};

export function CloudflareZonePage({ onLogout }: { onLogout: () => void }) {
  const params = useParams<{ zoneId: string }>();
  const numericZoneId = Number(params.zoneId);
  const navigate = useNavigate();

  const [zone, setZone] = useState<CloudflareZoneDetail | null>(null);
  const [records, setRecords] = useState<CloudflareRecord[]>([]);
  const [loadBalancers, setLoadBalancers] = useState<CloudflareLoadBalancer[]>([]);
  const [recordForm, setRecordForm] = useState(defaultRecordForm);
  const [editingRecordId, setEditingRecordId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(defaultRecordForm);
  const [syncRemote, setSyncRemote] = useState(true);
  const [recordMessage, setRecordMessage] = useState<string | null>(null);
  const [recordSearch, setRecordSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [recordLoading, setRecordLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [recordToDelete, setRecordToDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [recordsPerPage] = useState(50);
  const [syncModalOpen, setSyncModalOpen] = useState(false);

  const [showLbEditor, setShowLbEditor] = useState(false);
  const [editingLoadBalancer, setEditingLoadBalancer] = useState<any>(null);
  const [lbToDelete, setLbToDelete] = useState<{ id: number; name: string } | null>(null);
  const [lbDeleteModalOpen, setLbDeleteModalOpen] = useState(false);
  const [lbDeleteConfirmText, setLbDeleteConfirmText] = useState("");

  const [soaRecord, setSoaRecord] = useState<SoaRecord | null>(null);
  const [soaForm, setSoaForm] = useState<Omit<SoaRecord, "id">>({
    origin: "",
    ns: "",
    mbox: "",
    serial: 1,
    refresh: 28800,
    retry: 7200,
    expire: 604800,
    minimum: 86400,
    ttl: 86400,
    active: "Y",
  });
  const [soaMessage, setSoaMessage] = useState<string | null>(null);
  const filteredRecords = useMemo(() => {
    if (!recordSearch.trim()) return records;
    const q = recordSearch.toLowerCase();
    return records.filter(
      (record) =>
        record.name.toLowerCase().includes(q) ||
        record.content.toLowerCase().includes(q) ||
        record.record_type.toLowerCase().includes(q) ||
        (record.comment && record.comment.toLowerCase().includes(q)) ||
        (record.tags && record.tags.toLowerCase().includes(q)),
    );
  }, [records, recordSearch]);

  const paginatedRecords = useMemo(() => {
    const startIndex = (currentPage - 1) * recordsPerPage;
    const endIndex = startIndex + recordsPerPage;
    return filteredRecords.slice(startIndex, endIndex);
  }, [filteredRecords, currentPage, recordsPerPage]);

  const totalPages = Math.ceil(filteredRecords.length / recordsPerPage);

  useEffect(() => {
    setCurrentPage(1);
  }, [recordSearch]);

  useEffect(() => {
    if (!Number.isFinite(numericZoneId)) return;
    loadZone();
  }, [numericZoneId]);

  useEffect(() => {
    if (zone?.name) {
      loadSoa(zone.name);
    }
  }, [zone?.name]);

  function exportToCSV() {
    const csvHeaders = ["Type", "Name", "Content", "TTL", "Proxied", "Priority", "Comment", "Tags"];
    const csvRows = filteredRecords.map((record) => [
      record.record_type,
      record.name,
      record.content,
      record.ttl,
      record.proxied ? "Yes" : "No",
      record.priority || "",
      record.comment || "",
      record.tags || "",
    ]);

    const csvContent = [
      csvHeaders.join(","),
      ...csvRows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `${zone?.name || "zone"}_records_${new Date().toISOString().split("T")[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("Records exported to CSV");
  }

  async function loadZone() {
    setRecordMessage(null);
    try {
      const detail = await getCloudflareZone(numericZoneId);
      setZone(detail);
      await Promise.all([
        loadZoneRecords(numericZoneId),
        loadZoneLoadBalancers(numericZoneId)
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load zone";
      setRecordMessage(message);
      toast.error(message);
    }
  }

  async function loadZoneRecords(id: number) {
    const data = await getCloudflareZoneRecords<CloudflareRecord[]>(id);
    setRecords(data);
  }

  async function loadZoneLoadBalancers(id: number) {
    try {
      const data = await getCloudflareZoneLoadBalancers<CloudflareLoadBalancer[]>(id);
      setLoadBalancers(data);
    } catch (error) {
      console.error("Failed to load load balancers:", error);
      setLoadBalancers([]);
    }
  }

  async function loadSoa(zoneName: string) {
    try {
      const allSoa = await apiRequest<SoaRecord[]>("/soa");
      const match = allSoa.find(
        (soa) => soa.origin.replace(/\.$/, "").toLowerCase() === zoneName.replace(/\.$/, "").toLowerCase(),
      );
      if (match) {
        setSoaRecord(match);
        setSoaForm({
          origin: match.origin,
          ns: match.ns,
          mbox: match.mbox,
          serial: match.serial,
          refresh: match.refresh,
          retry: match.retry,
          expire: match.expire,
          minimum: match.minimum,
          ttl: match.ttl,
          active: match.active,
        });
      } else {
        setSoaRecord(null);
      }
    } catch (error) {
      setSoaMessage(error instanceof Error ? error.message : "Failed to load SOA");
    }
  }

  function handleRecordFormChange<T extends keyof typeof recordForm>(key: T, value: any) {
    setRecordForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleEditFormChange<T extends keyof typeof editForm>(key: T, value: any) {
    setEditForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleCreateRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecordMessage(null);
    setRecordLoading(true);
    try {
      await createCloudflareRecord(
        numericZoneId,
        {
          type: recordForm.type,
          name: recordForm.name,
          content: recordForm.content,
          ttl: Number(recordForm.ttl) || undefined,
          proxied: Boolean(recordForm.proxied),
          priority: Number(recordForm.priority) || undefined,
          comment: recordForm.comment || undefined,
          tags: recordForm.tags || undefined,
        },
        syncRemote,
      );
      setRecordForm(defaultRecordForm);
      setShowAddForm(false);
      await loadZoneRecords(numericZoneId);
      toast.success("Record created successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create record";
      setRecordMessage(message);
      toast.error(message);
    } finally {
      setRecordLoading(false);
    }
  }

  function startEditRecord(record: CloudflareRecord) {
    setEditingRecordId(record.id);
    setEditForm({
      type: record.record_type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      proxied: record.proxied ? record.proxied > 0 : false,
      priority: record.priority ?? 0,
      weight: 0,
      port: 0,
      comment: record.comment || "",
      tags: record.tags || "",
    });
  }

  function cancelEditRecord() {
    setEditingRecordId(null);
    setEditForm(defaultRecordForm);
  }

  async function handleUpdateRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingRecordId === null) return;
    setRecordMessage(null);
    setRecordLoading(true);
    try {
      await updateCloudflareRecord(
        editingRecordId,
        {
          type: editForm.type,
          name: editForm.name,
          content: editForm.content,
          ttl: Number(editForm.ttl) || undefined,
          proxied: Boolean(editForm.proxied),
          priority: Number(editForm.priority) || undefined,
          comment: editForm.comment || undefined,
          tags: editForm.tags || undefined,
        },
        syncRemote,
      );
      setEditingRecordId(null);
      setEditForm(defaultRecordForm);
      await loadZoneRecords(numericZoneId);
      toast.success("Record updated successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update record";
      setRecordMessage(message);
      toast.error(message);
    } finally {
      setRecordLoading(false);
    }
  }

  async function toggleRecordProxy(record: CloudflareRecord) {
    const next = !(record.proxied && record.proxied > 0);
    let ttl = record.ttl || 300;
    if (!next && ttl === 1) {
      ttl = 300;
    }
    if (next && (ttl ?? 0) < 1) {
      ttl = 1;
    }
    setRecordMessage(null);
    setRecordLoading(true);
    try {
      await updateCloudflareRecord(
        record.id,
        {
          type: record.record_type,
          name: record.name,
          content: record.content,
          ttl,
          proxied: next,
          priority: record.priority,
        },
        syncRemote,
      );
      await loadZoneRecords(numericZoneId);
    } catch (error) {
      setRecordMessage(error instanceof Error ? error.message : "Failed to toggle proxy mode");
    } finally {
      setRecordLoading(false);
    }
  }

  function openDeleteModal(record: CloudflareRecord) {
    setRecordToDelete({ id: record.id, name: record.name });
    setDeleteConfirmText("");
    setDeleteModalOpen(true);
  }

  function closeDeleteModal() {
    setDeleteModalOpen(false);
    setRecordToDelete(null);
    setDeleteConfirmText("");
  }

  async function confirmDeleteRecord() {
    if (!recordToDelete) return;
    setRecordMessage(null);
    setRecordLoading(true);
    try {
      await deleteCloudflareRecord(recordToDelete.id, syncRemote);
      closeDeleteModal();
      if (editingRecordId === recordToDelete.id) {
        setEditingRecordId(null);
        setEditForm(defaultRecordForm);
      }
      await loadZoneRecords(numericZoneId);
      toast.success("Record deleted successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete record";
      setRecordMessage(message);
      toast.error(message);
    } finally {
      setRecordLoading(false);
    }
  }

  async function handleSyncZone(mode: SyncMode) {
    setRecordMessage(null);
    setRecordLoading(true);
    try {
      await syncCloudflareZone(numericZoneId, mode);
      await loadZoneRecords(numericZoneId);
      setSyncModalOpen(false);
      toast.success("Zone synced successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      setRecordMessage(message);
      toast.error(message);
    } finally {
      setRecordLoading(false);
    }
  }

  function startAddLoadBalancer() {
    setEditingLoadBalancer(null);
    setShowLbEditor(true);
  }

  async function startEditLoadBalancer(lb: CloudflareLoadBalancer) {
    try {
      setRecordLoading(true);
      // Fetch pools with their origins for this load balancer
      const pools = await getLoadBalancerPools(lb.id);

      // Fetch origins for each pool
      const poolsWithOrigins = await Promise.all(
        pools.map(async (pool: any) => {
          const poolDetail = await getPool(pool.id);
          return {
            ...pool,
            origins: poolDetail.origins || [],
          };
        })
      );

      setEditingLoadBalancer({
        ...lb,
        pools: poolsWithOrigins,
      });
      setShowLbEditor(true);
    } catch (error) {
      toast.error("Failed to load load balancer details");
      console.error(error);
    } finally {
      setRecordLoading(false);
    }
  }

  async function handleSaveLoadBalancer(lbData: any) {
    setRecordLoading(true);
    try {
      const payload = {
        name: lbData.name,
        enabled: lbData.enabled,
        proxied: lbData.proxied,
        ttl: lbData.ttl || 30,
        steering_policy: lbData.steering_policy,
        session_affinity: lbData.session_affinity || "none",
        session_affinity_ttl: lbData.session_affinity_ttl || 82800,
        pools: lbData.pools,
      };

      if (editingLoadBalancer) {
        await updateCloudflareLoadBalancer(editingLoadBalancer.id, payload, syncRemote);
        toast.success("Load balancer updated successfully");
      } else {
        await createCloudflareLoadBalancer(numericZoneId, payload, syncRemote);
        toast.success("Load balancer created successfully");
      }

      setShowLbEditor(false);
      setEditingLoadBalancer(null);
      await loadZoneLoadBalancers(numericZoneId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save load balancer";
      toast.error(message);
    } finally {
      setRecordLoading(false);
    }
  }

  function openLbDeleteModal(lb: CloudflareLoadBalancer) {
    setLbToDelete({ id: lb.id, name: lb.name });
    setLbDeleteConfirmText("");
    setLbDeleteModalOpen(true);
  }

  function closeLbDeleteModal() {
    setLbDeleteModalOpen(false);
    setLbToDelete(null);
    setLbDeleteConfirmText("");
  }

  async function confirmDeleteLoadBalancer() {
    if (!lbToDelete) return;
    setRecordLoading(true);
    try {
      await deleteCloudflareLoadBalancer(lbToDelete.id, syncRemote);
      closeLbDeleteModal();
      await loadZoneLoadBalancers(numericZoneId);
      toast.success("Load balancer deleted successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete load balancer";
      toast.error(message);
    } finally {
      setRecordLoading(false);
    }
  }

  async function handleSoaSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!soaRecord) return;
    try {
      await apiRequest(`/soa/${soaRecord.id}`, {
        method: "PUT",
        body: JSON.stringify({
          ns: soaForm.ns,
          mbox: soaForm.mbox,
          serial: Number(soaForm.serial),
          refresh: Number(soaForm.refresh),
          retry: Number(soaForm.retry),
          expire: Number(soaForm.expire),
          minimum: Number(soaForm.minimum),
          ttl: Number(soaForm.ttl),
          active: soaForm.active,
        }),
      });
      setSoaMessage("SOA updated");
      await loadSoa(zone?.name || "");
    } catch (error) {
      setSoaMessage(error instanceof Error ? error.message : "Failed to update SOA");
    }
  }

  if (!Number.isFinite(numericZoneId)) {
    return <p className="p-6 text-sm text-destructive">Invalid zone id.</p>;
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <ToastContainer />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-6 py-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            Back
          </Button>
          <div>
            <h1 className="text-xl font-semibold">Cloudflare Zone</h1>
            {zone && (
              <p className="text-sm text-muted-foreground">
                {zone.name} · Account: {zone.account_name || "Unknown"}
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate("/")}>
            Dashboard
          </Button>
          <Button variant="ghost" onClick={onLogout}>
            Logout
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {zone && (
          <Card>
            <CardHeader>
              <CardTitle>Zone Overview</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <div>
                <Label className="text-xs uppercase text-muted-foreground">Zone</Label>
                <p className="font-semibold">{zone.name}</p>
              </div>
              <div>
                <Label className="text-xs uppercase text-muted-foreground">Account</Label>
                <p>{zone.account_name || "N/A"}</p>
                <p className="text-xs text-muted-foreground">{zone.cf_account_id}</p>
              </div>
              <div>
                <Label className="text-xs uppercase text-muted-foreground">Status</Label>
                <p>{zone.status || "Unknown"}</p>
                <p className="text-xs text-muted-foreground">{zone.plan_name || "Plan unknown"}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {soaRecord && (
          <Card>
            <CardHeader>
              <CardTitle>SOA Record</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="grid gap-3 md:grid-cols-3" onSubmit={handleSoaSubmit}>
                {(["ns","mbox","serial","refresh","retry","expire","minimum","ttl"] as const).map((field) => (
                  <div key={field}>
                    <Label htmlFor={`soa-${field}`}>{field.toUpperCase()}</Label>
                    <Input
                      id={`soa-${field}`}
                      type={field === "ns" || field === "mbox" ? "text" : "number"}
                      value={(soaForm as any)[field]}
                      onChange={(e) =>
                        setSoaForm((prev) => ({
                          ...prev,
                          [field]: field === "ns" || field === "mbox" ? e.target.value : Number(e.target.value),
                        }))
                      }
                      required
                    />
                  </div>
                ))}
                <div>
                  <Label htmlFor="soa-active">Active</Label>
                  <select
                    id="soa-active"
                    className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                    value={soaForm.active}
                    onChange={(e) => setSoaForm((prev) => ({ ...prev, active: e.target.value as "Y" | "N" }))}
                  >
                    <option value="Y">Yes</option>
                    <option value="N">No</option>
                  </select>
                </div>
                <div className="md:col-span-3 flex items-center gap-3">
                  <Button type="submit" size="sm">
                    Update SOA
                  </Button>
                  {soaMessage && <p className="text-sm text-muted-foreground">{soaMessage}</p>}
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Load Balancers</CardTitle>
            <Button size="sm" onClick={startAddLoadBalancer}>
              Add Load Balancer
            </Button>
          </CardHeader>
          <CardContent>
            {loadBalancers.length === 0 ? (
              <p className="text-sm text-gray-500">No load balancers configured for this zone.</p>
            ) : (
              <div className="space-y-2">
                {loadBalancers.map((lb) => (
                  <div
                    key={lb.id}
                    className="flex items-center justify-between rounded-lg border bg-gray-50 p-4 hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center rounded bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">
                        LB
                      </span>
                      <div>
                        <p className="font-medium text-blue-600">{lb.name}</p>
                        <div className="flex items-center gap-3 text-xs text-gray-600 mt-1">
                          {lb.enabled ? (
                            <span className="text-green-600">● Enabled</span>
                          ) : (
                            <span className="text-gray-400">● Disabled</span>
                          )}
                          {lb.proxied ? (
                            <span className="text-orange-600">Proxied</span>
                          ) : (
                            <span className="text-gray-500">DNS only</span>
                          )}
                          {lb.steering_policy && (
                            <span>Policy: {lb.steering_policy}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEditLoadBalancer(lb)}
                        className="text-blue-600 hover:text-blue-700"
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openLbDeleteModal(lb)}
                        className="text-red-600 hover:text-red-700"
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>DNS Records</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1 text-sm md:flex-row md:items-center md:gap-2">
                <label className="inline-flex items-center gap-2 text-sm" htmlFor="remote-sync-toggle">
                  <input
                    id="remote-sync-toggle"
                    type="checkbox"
                    checked={syncRemote}
                    onChange={(e) => setSyncRemote(e.target.checked)}
                  />
                  <span>Call Cloudflare API immediately</span>
                </label>
                <p className="text-xs text-muted-foreground">
                  Disable if Cloudflare is down or you only want to stage DB updates.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={exportToCSV} disabled={filteredRecords.length === 0}>
                  Export CSV
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSyncModalOpen(true)} disabled={recordLoading}>
                  {recordLoading ? "Syncing..." : "Sync from Cloudflare"}
                </Button>
                <Button variant="default" size="sm" onClick={() => setShowAddForm((prev) => !prev)}>
                  {showAddForm ? "Close add panel" : "Add record"}
                </Button>
              </div>
            </div>
            {recordMessage && <p className="text-sm text-destructive">{recordMessage}</p>}
            <div className="md:w-1/3">
              <Label htmlFor="record-search">Search records</Label>
              <Input
                id="record-search"
                placeholder="Filter by name, content, type, tags, or comment"
                value={recordSearch}
                onChange={(e) => setRecordSearch(e.target.value)}
              />
            </div>
            {showAddForm && (
              <form className="space-y-4 rounded-md border bg-white p-6" onSubmit={handleCreateRecord}>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                  <div>
                    <Label htmlFor="record-type" className="text-sm font-medium">Type</Label>
                    <select
                      id="record-type"
                      className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                      value={recordForm.type}
                      onChange={(e) => handleRecordFormChange("type", e.target.value)}
                    >
                      {RECORD_TYPE_LIST.map((type) => (
                        <option key={type.value} value={type.value}>{type.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="record-name" className="text-sm font-medium">Name (required)</Label>
                    <Input
                      id="record-name"
                      value={recordForm.name}
                      onChange={(e) => handleRecordFormChange("name", e.target.value)}
                      className="mt-1"
                      required
                    />
                    <p className="mt-1 text-xs text-gray-500">Use @ for root</p>
                  </div>
                  <div className="md:col-span-2">
                    <Label htmlFor="record-content" className="text-sm font-medium">
                      {(RECORD_TYPES[recordForm.type] || RECORD_TYPES.A).contentLabel} (required)
                    </Label>
                    <Input
                      id="record-content"
                      value={recordForm.content}
                      onChange={(e) => handleRecordFormChange("content", e.target.value)}
                      placeholder={(RECORD_TYPES[recordForm.type] || RECORD_TYPES.A).contentPlaceholder}
                      className="mt-1"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
                  <div>
                    <Label htmlFor="record-ttl" className="text-sm font-medium">TTL</Label>
                    <select
                      id="record-ttl"
                      className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                      value={recordForm.ttl}
                      onChange={(e) => handleRecordFormChange("ttl", Number(e.target.value))}
                    >
                      {TTL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  {(RECORD_TYPES[recordForm.type] || RECORD_TYPES.A).supportsPriority && (
                    <div>
                      <Label htmlFor="record-priority" className="text-sm font-medium">Priority</Label>
                      <Input
                        id="record-priority"
                        type="number"
                        min="0"
                        max="65535"
                        value={recordForm.priority}
                        onChange={(e) => handleRecordFormChange("priority", Number(e.target.value))}
                        className="mt-1"
                      />
                      <p className="mt-1 text-xs text-gray-500">0 - 65535</p>
                    </div>
                  )}
                </div>

                <div className="border-t pt-4">
                  <h4 className="mb-3 text-sm font-semibold">Record Attributes</h4>
                  <p className="mb-4 text-xs text-gray-600">
                    The information provided here will not impact DNS record resolution and is only meant for your reference.
                  </p>

                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="record-comment" className="text-sm font-medium">Comment</Label>
                      <Input
                        id="record-comment"
                        value={recordForm.comment}
                        onChange={(e) => handleRecordFormChange("comment", e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                        placeholder="Enter your comment here (up to 500 characters)."
                        maxLength={500}
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="record-tags" className="text-sm font-medium">Tags</Label>
                      <TagInput
                        value={recordForm.tags}
                        onChange={(value) => handleRecordFormChange("tags", value)}
                        placeholder="Add tags (press Enter or comma to add)"
                        className="mt-1"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button type="button" variant="outline" onClick={() => setShowAddForm(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={recordLoading}>
                    Add record
                  </Button>
                </div>
              </form>
            )}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <p>
                Showing {filteredRecords.length > 0 ? (currentPage - 1) * recordsPerPage + 1 : 0} to{" "}
                {Math.min(currentPage * recordsPerPage, filteredRecords.length)} of {filteredRecords.length} records
              </p>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                  >
                    Previous
                  </Button>
                  <span className="px-2">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
            {filteredRecords.length === 0 ? (
              <p className="text-sm text-muted-foreground">No records match your search.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Content</TableHead>
                    <TableHead>Proxy status</TableHead>
                    <TableHead>TTL</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedRecords.map((record) => {
                    const isEditing = editingRecordId === record.id;
                    const isProxied = record.proxied ? record.proxied > 0 : false;
                    const recordTypeConfig = RECORD_TYPES[record.record_type] || RECORD_TYPES.A;
                    const recordTags = record.tags ? record.tags.split(",").filter(t => t.trim()) : [];

                    return (
                      <>
                        <TableRow key={record.id} className={isEditing ? "bg-gray-50" : ""}>
                          <TableCell className="font-semibold">{record.record_type}</TableCell>
                          <TableCell className="font-mono text-sm">{record.name || "@"}</TableCell>
                          <TableCell className="max-w-[300px] truncate text-sm">
                            {record.content}
                            {record.priority !== null && record.priority !== undefined && record.priority !== 0 && (
                              <span className="ml-2 inline-block rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                                {record.priority}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <button
                              type="button"
                              className={`rounded px-2 py-1 text-xs font-medium ${
                                isProxied ? "bg-orange-100 text-orange-700" : "bg-slate-100 text-slate-700"
                              }`}
                              onClick={() => toggleRecordProxy(record)}
                              disabled={recordLoading || isEditing}
                            >
                              {isProxied ? "Proxied" : "DNS only"}
                            </button>
                          </TableCell>
                          <TableCell className="text-sm">{getTTLLabel(record.ttl)}</TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => isEditing ? cancelEditRecord() : startEditRecord(record)}
                              className="text-blue-600 hover:text-blue-700"
                            >
                              {isEditing ? "Edit ▲" : "Edit ▸"}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {isEditing && (
                          <TableRow key={`${record.id}-edit`}>
                            <TableCell colSpan={6} className="bg-white p-6">
                              <form onSubmit={handleUpdateRecord} className="space-y-6">
                                <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                                  <div>
                                    <Label htmlFor="edit-type" className="text-sm font-medium">Type</Label>
                                    <select
                                      id="edit-type"
                                      className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                      value={editForm.type}
                                      onChange={(e) => handleEditFormChange("type", e.target.value)}
                                    >
                                      {RECORD_TYPE_LIST.map((type) => (
                                        <option key={type.value} value={type.value}>{type.label}</option>
                                      ))}
                                    </select>
                                  </div>
                                  <div>
                                    <Label htmlFor="edit-name" className="text-sm font-medium">Name (required)</Label>
                                    <Input
                                      id="edit-name"
                                      value={editForm.name}
                                      onChange={(e) => handleEditFormChange("name", e.target.value)}
                                      className="mt-1"
                                      required
                                    />
                                    <p className="mt-1 text-xs text-gray-500">Use @ for root</p>
                                  </div>
                                  <div className="md:col-span-2">
                                    <Label htmlFor="edit-content" className="text-sm font-medium">
                                      {recordTypeConfig.contentLabel} (required)
                                    </Label>
                                    <Input
                                      id="edit-content"
                                      value={editForm.content}
                                      onChange={(e) => handleEditFormChange("content", e.target.value)}
                                      placeholder={recordTypeConfig.contentPlaceholder}
                                      className="mt-1"
                                      required
                                    />
                                  </div>
                                </div>

                                <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
                                  <div>
                                    <Label htmlFor="edit-ttl" className="text-sm font-medium">TTL</Label>
                                    <select
                                      id="edit-ttl"
                                      className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                      value={editForm.ttl}
                                      onChange={(e) => handleEditFormChange("ttl", Number(e.target.value))}
                                    >
                                      {TTL_OPTIONS.map((opt) => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                      ))}
                                    </select>
                                  </div>
                                  {recordTypeConfig.supportsPriority && (
                                    <div>
                                      <Label htmlFor="edit-priority" className="text-sm font-medium">Priority</Label>
                                      <Input
                                        id="edit-priority"
                                        type="number"
                                        min="0"
                                        max="65535"
                                        value={editForm.priority}
                                        onChange={(e) => handleEditFormChange("priority", Number(e.target.value))}
                                        className="mt-1"
                                      />
                                      <p className="mt-1 text-xs text-gray-500">0 - 65535</p>
                                    </div>
                                  )}
                                </div>

                                <div className="border-t pt-4">
                                  <h4 className="mb-3 text-sm font-semibold">Record Attributes</h4>
                                  <p className="mb-4 text-xs text-gray-600">
                                    The information provided here will not impact DNS record resolution and is only meant for your reference.
                                  </p>

                                  <div className="space-y-4">
                                    <div>
                                      <Label htmlFor="edit-comment" className="text-sm font-medium">Comment</Label>
                                      <Input
                                        id="edit-comment"
                                        value={editForm.comment}
                                        onChange={(e) => handleEditFormChange("comment", e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                                        placeholder="Enter your comment here (up to 500 characters)."
                                        maxLength={500}
                                        className="mt-1"
                                      />
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-tags" className="text-sm font-medium">Tags</Label>
                                      <TagInput
                                        value={editForm.tags}
                                        onChange={(value) => handleEditFormChange("tags", value)}
                                        placeholder="Add tags (press Enter or comma to add)"
                                        className="mt-1"
                                      />
                                    </div>
                                  </div>
                                </div>

                                <div className="flex items-center justify-between border-t pt-4">
                                  <Button
                                    type="button"
                                    variant="destructive"
                                    onClick={() => openDeleteModal(record)}
                                    disabled={recordLoading}
                                  >
                                    Delete
                                  </Button>
                                  <div className="flex gap-2">
                                    <Button
                                      type="button"
                                      variant="outline"
                                      onClick={cancelEditRecord}
                                      disabled={recordLoading}
                                    >
                                      Cancel
                                    </Button>
                                    <Button type="submit" disabled={recordLoading}>
                                      Save
                                    </Button>
                                  </div>
                                </div>
                              </form>
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Sync Modal */}
      <SyncModal
        isOpen={syncModalOpen}
        onClose={() => setSyncModalOpen(false)}
        onSync={handleSyncZone}
        zoneName={zone?.name || ""}
        loading={recordLoading}
      />

      {/* Delete Confirmation Modal */}
      {deleteModalOpen && recordToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">Delete DNS Record</h3>
            <p className="mb-4 text-sm text-gray-700">
              Are you sure you want to delete this DNS record? This action cannot be undone.
            </p>
            <div className="mb-4">
              <p className="mb-2 text-sm font-medium text-gray-700">
                Type <span className="font-mono font-bold">{recordToDelete.name || "@"}</span> to confirm:
              </p>
              <Input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={recordToDelete.name || "@"}
                className="font-mono"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeDeleteModal} disabled={recordLoading}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmDeleteRecord}
                disabled={recordLoading || deleteConfirmText !== (recordToDelete.name || "@")}
              >
                {recordLoading ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Load Balancer Delete Confirmation Modal */}
      {lbDeleteModalOpen && lbToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">Delete Load Balancer</h3>
            <p className="mb-4 text-sm text-gray-700">
              Are you sure you want to delete this load balancer? This action cannot be undone.
            </p>
            <div className="mb-4">
              <p className="mb-2 text-sm font-medium text-gray-700">
                Type <span className="font-mono font-bold">{lbToDelete.name}</span> to confirm:
              </p>
              <Input
                value={lbDeleteConfirmText}
                onChange={(e) => setLbDeleteConfirmText(e.target.value)}
                placeholder={lbToDelete.name}
                className="font-mono"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeLbDeleteModal} disabled={recordLoading}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmDeleteLoadBalancer}
                disabled={recordLoading || lbDeleteConfirmText !== lbToDelete.name}
              >
                {recordLoading ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <LoadBalancerEditor
        isOpen={showLbEditor}
        onClose={() => {
          setShowLbEditor(false);
          setEditingLoadBalancer(null);
        }}
        onSave={handleSaveLoadBalancer}
        loadBalancer={editingLoadBalancer}
        zoneName={zone?.name || ""}
      />
    </div>
  );
}
