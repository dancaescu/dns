import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { apiRequest } from "../lib/api";
import { Star } from "lucide-react";
import { cn } from "../lib/utils";

interface SoaRecord {
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
}

interface RrRecord {
  id: number;
  zone: number;
  name: string;
  type: string;
  data: string;
  aux: number;
  ttl: number;
}

interface CloudflareZone {
  id: number;
  account_id: number;
  cf_zone_id: string;
  name: string;
  status: string;
  paused: number;
  zone_type: string | null;
  plan_name: string | null;
  account_name: string | null;
  favorite: number;
}

interface CloudflareAccount {
  id: number;
  cf_account_id: string;
  name: string;
}


export function Dashboard({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const [soaRecords, setSoaRecords] = useState<SoaRecord[]>([]);
  const [selectedSoa, setSelectedSoa] = useState<SoaRecord | null>(null);
  const [rrRecords, setRrRecords] = useState<RrRecord[]>([]);
  const [rrZoneId, setRrZoneId] = useState<number | null>(null);
  const [cfAccounts, setCfAccounts] = useState<CloudflareAccount[]>([]);
  const [cfZones, setCfZones] = useState<CloudflareZone[]>([]);
  const [favoriteZones, setFavoriteZones] = useState<CloudflareZone[]>([]);
  const [accountSearch, setAccountSearch] = useState("");
  const [zoneSearch, setZoneSearch] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [rrSearch, setRrSearch] = useState("");
  const [showRrAddForm, setShowRrAddForm] = useState(false);
  const [editingRrId, setEditingRrId] = useState<number | null>(null);
  const [editingRrData, setEditingRrData] = useState<RrRecord | null>(null);
  const [rrDeleteModalOpen, setRrDeleteModalOpen] = useState(false);
  const [rrToDelete, setRrToDelete] = useState<{ id: number; name: string } | null>(null);
  const [rrDeleteConfirm, setRrDeleteConfirm] = useState("");
  const [rrCurrentPage, setRrCurrentPage] = useState(1);
  const rrRecordsPerPage = 10;
  const [editFormData, setEditFormData] = useState<Partial<RrRecord>>({});

  useEffect(() => {
    refreshSoa();
    loadAccounts();
    loadZones();
  }, []);

  useEffect(() => {
    loadZones();
  }, [selectedAccountId, zoneSearch]);

  useEffect(() => {
    if (rrZoneId) {
      refreshRr(rrZoneId);
    } else {
      setRrRecords([]);
    }
    setRrCurrentPage(1);
  }, [rrZoneId]);

  useEffect(() => {
    setRrCurrentPage(1);
  }, [rrSearch]);


  useEffect(() => {
    if (!accountSearch) {
      setSelectedAccountId(null);
      return;
    }
    const lowered = accountSearch.toLowerCase();
    const match = cfAccounts.find(
      (account) =>
        account.name.toLowerCase().includes(lowered) || account.cf_account_id.toLowerCase().includes(lowered),
    );
    setSelectedAccountId(match ? match.id : null);
  }, [accountSearch, cfAccounts]);

  useEffect(() => {
    if (selectedAccountId) {
      setExpandedAccounts((prev) => {
        if (prev.has(selectedAccountId)) return prev;
        const next = new Set(prev);
        next.add(selectedAccountId);
        return next;
      });
    }
  }, [selectedAccountId]);

  const rrZoneOptions = useMemo(
    () =>
      soaRecords.map((soa) => (
        <option key={soa.id} value={soa.id}>
          {soa.origin}
        </option>
      )),
    [soaRecords],
  );

  const filteredRrRecords = useMemo(() => {
    if (!rrSearch) return rrRecords;
    const lower = rrSearch.toLowerCase();
    return rrRecords.filter(
      (rr) =>
        rr.name.toLowerCase().includes(lower) ||
        rr.type.toLowerCase().includes(lower) ||
        rr.data.toLowerCase().includes(lower)
    );
  }, [rrRecords, rrSearch]);

  const paginatedRrRecords = useMemo(() => {
    const startIndex = (rrCurrentPage - 1) * rrRecordsPerPage;
    const endIndex = startIndex + rrRecordsPerPage;
    return filteredRrRecords.slice(startIndex, endIndex);
  }, [filteredRrRecords, rrCurrentPage, rrRecordsPerPage]);

  const rrTotalPages = Math.ceil(filteredRrRecords.length / rrRecordsPerPage);

  async function refreshSoa() {
    const data = await apiRequest<SoaRecord[]>("/soa");
    setSoaRecords(data);
    if (data.length) {
      if (selectedSoa) {
        const current = data.find((soa) => soa.id === selectedSoa.id) || data[0];
        setSelectedSoa(current);
        setRrZoneId(current?.id ?? null);
      } else {
        setSelectedSoa(data[0]);
        setRrZoneId(data[0].id);
      }
    } else {
      setSelectedSoa(null);
      setRrZoneId(null);
    }
  }

  async function refreshRr(zoneId: number) {
    const data = await apiRequest<RrRecord[]>(`/rr?zone=${zoneId}`);
    setRrRecords(data);
  }

  async function loadAccounts() {
    const accounts = await apiRequest<CloudflareAccount[]>("/cloudflare/accounts");
    setCfAccounts(accounts);
  }

  async function loadZones() {
    const params = new URLSearchParams();
    if (selectedAccountId) {
      params.set("account_id", String(selectedAccountId));
    }
    if (zoneSearch.trim()) {
      params.set("search", zoneSearch.trim());
    }
    const endpoint = params.toString() ? `/cloudflare/zones?${params.toString()}` : "/cloudflare/zones";
    const zones = await apiRequest<CloudflareZone[]>(endpoint);
    setCfZones(zones);
    setFavoriteZones(zones.filter((zone) => Boolean(zone.favorite)));
    if (!zones.length) {
      return;
    }
  }


  async function handleSoaSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSoa) return;
    setLoading(true);
    setMessage(null);
    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());
    try {
      await apiRequest(`/soa/${selectedSoa.id}`, {
        method: "PUT",
        body: JSON.stringify({
          ns: payload.ns,
          mbox: payload.mbox,
          serial: Number(payload.serial),
          refresh: Number(payload.refresh),
          retry: Number(payload.retry),
          expire: Number(payload.expire),
          minimum: Number(payload.minimum),
          ttl: Number(payload.ttl),
          active: payload.active,
        }),
      });
      setMessage("SOA updated");
      await refreshSoa();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Update failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleRrCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rrZoneId) return;
    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());
    await apiRequest("/rr", {
      method: "POST",
      body: JSON.stringify({
        zone: rrZoneId,
        name: payload.name,
        type: payload.type,
        data: payload.data,
        aux: Number(payload.aux || 0),
        ttl: Number(payload.ttl || 86400),
      }),
    });
    event.currentTarget.reset();
    setShowRrAddForm(false);
    refreshRr(rrZoneId);
  }

  async function handleRrUpdate() {
    if (!editingRrId || !rrZoneId) return;
    try {
      await apiRequest(`/rr/${editingRrId}`, {
        method: "PUT",
        body: JSON.stringify({
          zone: rrZoneId,
          name: editFormData.name,
          type: editFormData.type,
          data: editFormData.data,
          aux: Number(editFormData.aux || 0),
          ttl: Number(editFormData.ttl || 86400),
        }),
      });
      setEditingRrId(null);
      setEditingRrData(null);
      setEditFormData({});
      refreshRr(rrZoneId);
    } catch (error) {
      console.error("Failed to update record:", error);
      alert("Failed to update record");
    }
  }

  function startEditRr(rr: RrRecord) {
    setEditingRrId(rr.id);
    setEditingRrData(rr);
    setEditFormData({
      name: rr.name,
      type: rr.type,
      data: rr.data,
      aux: rr.aux,
      ttl: rr.ttl,
    });
    setShowRrAddForm(false);
  }

  function cancelEditRr() {
    setEditingRrId(null);
    setEditingRrData(null);
    setEditFormData({});
  }

  function openRrDeleteModal(rr: RrRecord) {
    setRrToDelete({ id: rr.id, name: rr.name });
    setRrDeleteModalOpen(true);
    setRrDeleteConfirm("");
  }

  async function confirmDeleteRr() {
    if (!rrToDelete || !rrZoneId) return;
    if (rrDeleteConfirm !== rrToDelete.name) {
      alert("Name does not match");
      return;
    }
    await apiRequest(`/rr/${rrToDelete.id}`, { method: "DELETE" });
    setRrDeleteModalOpen(false);
    setRrToDelete(null);
    setRrDeleteConfirm("");
    refreshRr(rrZoneId);
  }


  async function toggleFavorite(zone: CloudflareZone) {
    const nextFavorite = !Boolean(zone.favorite);
    await apiRequest(`/cloudflare/zones/${zone.id}/favorite`, {
      method: "POST",
      body: JSON.stringify({ favorite: nextFavorite }),
    });
    loadZones();
  }

  function openZone(zoneId: number) {
    navigate(`/cloudflare/zones/${zoneId}`);
  }

  const groupedAccounts = useMemo(() => {
    const groups: Record<number, CloudflareZone[]> = {};
    for (const zone of cfZones) {
      if (!groups[zone.account_id]) {
        groups[zone.account_id] = [];
      }
      groups[zone.account_id].push(zone);
    }
    return Object.entries(groups).map(([accountId, zones]) => ({
      account: cfAccounts.find((acc) => acc.id === Number(accountId)) || null,
      zones,
    }));
  }, [cfZones, cfAccounts]);

  const toggleAccountSection = (accountId: number) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">DNS Manager</h1>
          <p className="text-sm text-muted-foreground">Manage SOA/RR and mirrored Cloudflare data</p>
        </div>
        <Button variant="outline" onClick={onLogout}>
          Logout
        </Button>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <Tabs defaultValue="soa">
          <TabsList>
            <TabsTrigger value="soa">SOA Records</TabsTrigger>
            <TabsTrigger value="rr">Resource Records</TabsTrigger>
            <TabsTrigger value="cloudflare">Cloudflare Mirror</TabsTrigger>
          </TabsList>
          <TabsContent value="soa">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Edit SOA</CardTitle>
                </CardHeader>
                <CardContent>
                  {selectedSoa ? (
                    <form key={selectedSoa.id} className="space-y-3" onSubmit={handleSoaSubmit}>
                      <div>
                        <Label>Origin</Label>
                        <div className="mt-1 rounded border bg-muted/40 px-3 py-2 text-sm">{selectedSoa.origin}</div>
                      </div>
                      {["ns", "mbox", "serial", "refresh", "retry", "expire", "minimum", "ttl"].map((field) => (
                        <div key={field}>
                          <Label htmlFor={`soa-${field}`}>{field.toUpperCase()}</Label>
                          <Input
                            id={`soa-${field}`}
                            name={field}
                            defaultValue={(selectedSoa as any)[field]}
                            type={field === "ns" || field === "mbox" ? "text" : "number"}
                            required
                          />
                        </div>
                      ))}
                      <div>
                        <Label htmlFor="soa-active">Active</Label>
                        <select
                          id="soa-active"
                          name="active"
                          defaultValue={selectedSoa.active}
                          className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        >
                          <option value="Y">Yes</option>
                          <option value="N">No</option>
                        </select>
                      </div>
                      {message && <p className="text-sm text-muted-foreground">{message}</p>}
                      <Button type="submit" disabled={loading}>
                        {loading ? "Saving..." : "Save changes"}
                      </Button>
                    </form>
                  ) : (
                    <p className="text-sm text-muted-foreground">Select a SOA record from the table.</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>SOA Records</CardTitle>
                </CardHeader>
                <CardContent className="max-h-[420px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Origin</TableHead>
                        <TableHead>NS</TableHead>
                        <TableHead>Serial</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {soaRecords.map((soa) => (
                        <TableRow
                          key={soa.id}
                          className={selectedSoa?.id === soa.id ? "bg-muted" : ""}
                          onClick={() => setSelectedSoa(soa)}
                        >
                          <TableCell>{soa.origin}</TableCell>
                          <TableCell>{soa.ns}</TableCell>
                          <TableCell>{soa.serial}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
          <TabsContent value="rr">
            <Card>
              <CardHeader>
                <CardTitle>Resource Records</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-4">
                    <div className="w-64">
                      <Label htmlFor="rr-zone-select" className="sr-only">Zone</Label>
                      <select
                        id="rr-zone-select"
                        className="w-full rounded-md border px-3 py-2 text-sm"
                        value={rrZoneId ?? ""}
                        onChange={(e) => setRrZoneId(Number(e.target.value))}
                      >
                        <option value="" disabled>
                          Select zone
                        </option>
                        {rrZoneOptions}
                      </select>
                    </div>
                    <div className="w-64">
                      <Label htmlFor="rr-search" className="sr-only">Search</Label>
                      <Input
                        id="rr-search"
                        placeholder="Filter by name, type, or content"
                        value={rrSearch}
                        onChange={(e) => setRrSearch(e.target.value)}
                      />
                    </div>
                  </div>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => setShowRrAddForm(!showRrAddForm)}
                    disabled={!rrZoneId}
                  >
                    {showRrAddForm ? "Close add panel" : "Add record"}
                  </Button>
                </div>

                {showRrAddForm && (
                  <form className="space-y-4 rounded-md border bg-white p-6" onSubmit={handleRrCreate}>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                      <div>
                        <Label htmlFor="rr-type" className="text-sm font-medium">Type</Label>
                        <select
                          id="rr-type"
                          name="type"
                          className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                          required
                        >
                          {["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "PTR", "RP", "NAPTR", "HINFO"].map((type) => (
                            <option key={type}>{type}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="rr-name" className="text-sm font-medium">Name</Label>
                        <Input id="rr-name" name="name" className="mt-1" required />
                      </div>
                      <div className="md:col-span-2">
                        <Label htmlFor="rr-data" className="text-sm font-medium">Content</Label>
                        <Input id="rr-data" name="data" className="mt-1" required />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                      <div>
                        <Label htmlFor="rr-aux" className="text-sm font-medium">Aux/Priority</Label>
                        <Input id="rr-aux" name="aux" type="number" defaultValue={0} className="mt-1" />
                      </div>
                      <div>
                        <Label htmlFor="rr-ttl" className="text-sm font-medium">TTL</Label>
                        <Input id="rr-ttl" name="ttl" type="number" defaultValue={86400} className="mt-1" />
                      </div>
                      <div className="flex items-end md:col-span-2">
                        <Button type="submit" className="w-full">
                          Add record
                        </Button>
                      </div>
                    </div>
                  </form>
                )}

                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Content</TableHead>
                        <TableHead>Aux</TableHead>
                        <TableHead>TTL</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedRrRecords.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                            {rrZoneId ? "No records found" : "Select a zone to view records"}
                          </TableCell>
                        </TableRow>
                      ) : (
                        paginatedRrRecords.map((rr) => (
                          <TableRow key={rr.id} className="hover:bg-muted/50">
                            {editingRrId === rr.id && editingRrData ? (
                              <>
                                <TableCell>
                                  <select
                                    value={editFormData.type || ""}
                                    onChange={(e) => setEditFormData({ ...editFormData, type: e.target.value })}
                                    className="w-full rounded border px-2 py-1 text-sm"
                                  >
                                    {["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "PTR", "RP", "NAPTR", "HINFO"].map((type) => (
                                      <option key={type}>{type}</option>
                                    ))}
                                  </select>
                                </TableCell>
                                <TableCell>
                                  <Input
                                    value={editFormData.name || ""}
                                    onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                                    className="text-sm"
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    value={editFormData.data || ""}
                                    onChange={(e) => setEditFormData({ ...editFormData, data: e.target.value })}
                                    className="text-sm"
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    value={editFormData.aux ?? 0}
                                    onChange={(e) => setEditFormData({ ...editFormData, aux: Number(e.target.value) })}
                                    className="w-20 text-sm"
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    value={editFormData.ttl ?? 86400}
                                    onChange={(e) => setEditFormData({ ...editFormData, ttl: Number(e.target.value) })}
                                    className="w-24 text-sm"
                                  />
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex justify-end gap-2">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={handleRrUpdate}
                                      className="text-green-600 hover:text-green-700"
                                    >
                                      Save
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={cancelEditRr}
                                      className="text-gray-600 hover:text-gray-700"
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </TableCell>
                              </>
                            ) : (
                              <>
                                <TableCell className="font-mono text-sm">{rr.type}</TableCell>
                                <TableCell className="font-medium">{rr.name}</TableCell>
                                <TableCell className="max-w-md truncate">{rr.data}</TableCell>
                                <TableCell className="text-sm text-muted-foreground">{rr.aux}</TableCell>
                                <TableCell className="text-sm text-muted-foreground">{rr.ttl}</TableCell>
                                <TableCell className="text-right">
                                  <div className="flex justify-end gap-2">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => startEditRr(rr)}
                                      className="text-blue-600 hover:text-blue-700"
                                    >
                                      Edit
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => openRrDeleteModal(rr)}
                                      className="text-red-600 hover:text-red-700"
                                    >
                                      Delete
                                    </Button>
                                  </div>
                                </TableCell>
                              </>
                            )}
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>

                {filteredRrRecords.length > 0 && (
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      Showing {((rrCurrentPage - 1) * rrRecordsPerPage) + 1} to {Math.min(rrCurrentPage * rrRecordsPerPage, filteredRrRecords.length)} of {filteredRrRecords.length} records
                      {rrSearch && ` (filtered from ${rrRecords.length} total)`}
                    </p>
                    {rrTotalPages > 1 && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRrCurrentPage(1)}
                          disabled={rrCurrentPage === 1}
                        >
                          First
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRrCurrentPage(rrCurrentPage - 1)}
                          disabled={rrCurrentPage === 1}
                        >
                          Previous
                        </Button>
                        <span className="text-sm text-muted-foreground">
                          Page {rrCurrentPage} of {rrTotalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRrCurrentPage(rrCurrentPage + 1)}
                          disabled={rrCurrentPage === rrTotalPages}
                        >
                          Next
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRrCurrentPage(rrTotalPages)}
                          disabled={rrCurrentPage === rrTotalPages}
                        >
                          Last
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Delete confirmation modal */}
            {rrDeleteModalOpen && rrToDelete && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
                <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
                  <h3 className="mb-4 text-lg font-semibold">Delete Resource Record</h3>
                  <p className="mb-4 text-sm text-gray-600">
                    Are you sure you want to delete this record? This action cannot be undone.
                  </p>
                  <div className="mb-4">
                    <p className="mb-2 text-sm font-medium">
                      Type <span className="font-mono font-bold">{rrToDelete.name}</span> to confirm:
                    </p>
                    <Input
                      value={rrDeleteConfirm}
                      onChange={(e) => setRrDeleteConfirm(e.target.value)}
                      placeholder="Type record name to confirm"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setRrDeleteModalOpen(false);
                        setRrToDelete(null);
                        setRrDeleteConfirm("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={confirmDeleteRr}
                      disabled={rrDeleteConfirm !== rrToDelete.name}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </TabsContent>
          <TabsContent value="cloudflare">
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Filters</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-3">
                    <div>
                      <Label htmlFor="account-filter">Account</Label>
                      <Input
                        id="account-filter"
                        list="account-options"
                        placeholder="Type to search accounts"
                        value={accountSearch}
                        onChange={(e) => setAccountSearch(e.target.value)}
                      />
                      <datalist id="account-options">
                        {cfAccounts.map((account) => (
                          <option key={account.id} value={account.name} />
                        ))}
                      </datalist>
                    </div>
                    <div>
                      <Label htmlFor="zone-filter">Zone</Label>
                      <Input
                        id="zone-filter"
                        placeholder="Search zones"
                        value={zoneSearch}
                        onChange={(e) => setZoneSearch(e.target.value)}
                      />
                    </div>
                    <div className="flex items-end">
                      <Button variant="ghost" onClick={() => { setAccountSearch(""); setZoneSearch(""); }}>
                        Clear filters
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <div className="rounded border bg-white px-4 py-3 text-sm text-muted-foreground">
                Click any View button to open the zone editor page in this window.
              </div>

              {favoriteZones.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Favorited Zones</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {favoriteZones.map((zone) => (
                      <div key={`fav-${zone.id}`} className="flex items-center justify-between rounded border px-3 py-2">
                        <div>
                          <p className="font-medium">{zone.name}</p>
                          <p className="text-xs text-muted-foreground">{zone.account_name}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="sm" onClick={() => openZone(zone.id)}>
                            View
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => toggleFavorite(zone)}>
                            <Star className="h-4 w-4 fill-yellow-400 text-yellow-500" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {groupedAccounts.length === 0 && <p className="text-sm text-muted-foreground">No zones found.</p>}

              {groupedAccounts.map(({ account, zones }) => {
                if (!account) return null;
                const expanded = expandedAccounts.has(account.id);
                return (
                  <div key={account.id} className="rounded border bg-white shadow-sm">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                      onClick={() => toggleAccountSection(account.id)}
                    >
                      <div>
                        <p className="font-semibold">{account.name}</p>
                        <p className="text-xs text-muted-foreground">{account.cf_account_id}</p>
                      </div>
                      <div className="text-sm text-muted-foreground">{expanded ? "Collapse" : "Expand"} ({zones.length})</div>
                    </button>
                    {expanded && (
                      <div className="border-t px-4 py-2">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Zone</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Plan</TableHead>
                              <TableHead>Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {zones.map((zone) => (
                                <TableRow key={zone.id}>
                                  <TableCell className="max-w-[220px] truncate">{zone.name}</TableCell>
                                <TableCell>{zone.status}</TableCell>
                                <TableCell>{zone.plan_name || "—"}</TableCell>
                                <TableCell>
                                    <div className="flex items-center gap-2">
                                      <Button variant="ghost" size="sm" onClick={() => openZone(zone.id)}>
                                        View
                                      </Button>
                                      <Button variant="ghost" size="sm" onClick={() => toggleFavorite(zone)}>
                                        <Star
                                          className={cn(
                                            "h-4 w-4",
                                            zone.favorite ? "fill-yellow-400 text-yellow-500" : "text-muted-foreground",
                                          )}
                                        />
                                      </Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                );
              })}

              <Card>
                <CardHeader>
                  <CardTitle>Zone management</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    Use the View buttons above to open a dedicated page for editing zone SOA and DNS records.
                  </p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
