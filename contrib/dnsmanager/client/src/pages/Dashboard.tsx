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
  }, [rrZoneId]);


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
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>New RR</CardTitle>
                </CardHeader>
                <CardContent>
                  <form className="space-y-3" onSubmit={handleRrCreate}>
                    <div>
                      <Label htmlFor="rr-zone">Zone</Label>
                      <select
                        id="rr-zone"
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        value={rrZoneId ?? ""}
                        onChange={(e) => setRrZoneId(Number(e.target.value))}
                      >
                        <option value="" disabled>
                          Select zone
                        </option>
                        {rrZoneOptions}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="rr-name">Name</Label>
                      <Input id="rr-name" name="name" required />
                    </div>
                    <div>
                      <Label htmlFor="rr-type">Type</Label>
                      <select id="rr-type" name="type" className="mt-1 w-full rounded-md border px-3 py-2 text-sm">
                        {["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "PTR", "RP", "NAPTR", "HINFO"].map((type) => (
                          <option key={type}>{type}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="rr-data">Content</Label>
                      <Input id="rr-data" name="data" required />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="rr-aux">Aux</Label>
                        <Input id="rr-aux" name="aux" type="number" defaultValue={0} />
                      </div>
                      <div>
                        <Label htmlFor="rr-ttl">TTL</Label>
                        <Input id="rr-ttl" name="ttl" type="number" defaultValue={86400} />
                      </div>
                    </div>
                    <Button type="submit" disabled={!rrZoneId}>
                      Add record
                    </Button>
                  </form>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Records</CardTitle>
                </CardHeader>
                <CardContent className="max-h-[420px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Content</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rrRecords.map((rr) => (
                        <TableRow key={rr.id}>
                          <TableCell>{rr.name}</TableCell>
                          <TableCell>{rr.type}</TableCell>
                          <TableCell className="max-w-[240px] truncate">{rr.data}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
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
