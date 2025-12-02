import { Fragment, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Badge } from "../components/ui/badge";
import { apiRequest } from "../lib/api";
import { toast } from "../components/ui/toast";
import {
  Shield,
  Key,
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  Play,
  Trash2,
  Info,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

interface DNSSECZone {
  id: number;
  origin: string;
  dnssec_enabled: boolean;
  nsec_mode: string | null;
  preferred_algorithm: number | null;
  auto_sign: boolean;
  signature_validity: number | null;
  signature_refresh: number | null;
  active_keys: number;
  signature_count: number;
}

interface DNSSECKey {
  id: number;
  zone_id: number;
  algorithm: number;
  key_tag: number;
  is_ksk: boolean;
  public_key: string;
  private_key: string;
  active: boolean;
  created_at: string;
  activated_at: string | null;
  expires_at: string | null;
}

interface SigningQueueItem {
  id: number;
  zone_id: number;
  origin: string;
  status: "pending" | "processing" | "completed" | "failed";
  reason: string;
  priority: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

interface DNSSECLog {
  id: number;
  zone_id: number;
  operation: string;
  message: string;
  success: boolean;
  timestamp: string;
}

const ALGORITHM_NAMES: Record<number, string> = {
  8: "RSASHA256",
  10: "RSASHA512",
  13: "ECDSAP256SHA256 (Recommended)",
  14: "ECDSAP384SHA384",
  15: "ED25519 (Fast)",
  16: "ED448",
};

export function DNSSECManagement({ onLogout, user }: { onLogout: () => void; user: User | null }) {
  const [zones, setZones] = useState<DNSSECZone[]>([]);
  const [selectedZone, setSelectedZone] = useState<DNSSECZone | null>(null);
  const [keys, setKeys] = useState<DNSSECKey[]>([]);
  const [queue, setQueue] = useState<SigningQueueItem[]>([]);
  const [logs, setLogs] = useState<DNSSECLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [enableDialogOpen, setEnableDialogOpen] = useState(false);
  const [selectedAlgorithm, setSelectedAlgorithm] = useState("13");
  const [selectedNsecMode, setSelectedNsecMode] = useState("NSEC3");
  const [autoSign, setAutoSign] = useState(true);
  const [keyGenDialogOpen, setKeyGenDialogOpen] = useState(false);
  const [keyGenIsKSK, setKeyGenIsKSK] = useState(false);
  const [keyGenAlgorithm, setKeyGenAlgorithm] = useState("13");
  const [keyGenKeySize, setKeyGenKeySize] = useState("2048");

  useEffect(() => {
    loadZones();
    loadQueue();
  }, []);

  useEffect(() => {
    if (selectedZone) {
      loadKeys(selectedZone.id);
      loadLogs(selectedZone.id);
    }
  }, [selectedZone]);

  const loadZones = async () => {
    try {
      const data = await apiRequest<DNSSECZone[]>("/dnssec/zones");
      setZones(data);
    } catch (error: any) {
      toast.error("Failed to load zones: " + error.message);
    }
  };

  const loadKeys = async (zoneId: number) => {
    try {
      const data = await apiRequest<DNSSECKey[]>(`/dnssec/keys/${zoneId}`);
      setKeys(data);
    } catch (error: any) {
      toast.error("Failed to load keys: " + error.message);
    }
  };

  const loadQueue = async () => {
    try {
      const data = await apiRequest<SigningQueueItem[]>("/dnssec/queue");
      setQueue(data);
    } catch (error: any) {
      toast.error("Failed to load signing queue: " + error.message);
    }
  };

  const loadLogs = async (zoneId: number) => {
    try {
      const data = await apiRequest<DNSSECLog[]>(`/dnssec/logs/${zoneId}?limit=20`);
      setLogs(data);
    } catch (error: any) {
      toast.error("Failed to load logs: " + error.message);
    }
  };

  const enableDNSSEC = async (zone: DNSSECZone) => {
    setLoading(true);
    try {
      await apiRequest(`/dnssec/zones/${zone.id}/enable`, {
        method: "POST",
        body: JSON.stringify({
          algorithm: parseInt(selectedAlgorithm),
          nsec_mode: selectedNsecMode,
          auto_sign: autoSign,
        }),
      });
      toast.success(`DNSSEC enabled for ${zone.origin}`);
      setEnableDialogOpen(false);
      loadZones();
    } catch (error: any) {
      toast.error("Failed to enable DNSSEC: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const disableDNSSEC = async (zone: DNSSECZone) => {
    if (!confirm(`Are you sure you want to disable DNSSEC for ${zone.origin}?\n\nThis will deactivate all keys and signatures.`)) {
      return;
    }

    setLoading(true);
    try {
      await apiRequest(`/dnssec/zones/${zone.id}/disable`, { method: "POST" });
      toast.success(`DNSSEC disabled for ${zone.origin}`);
      loadZones();
      if (selectedZone?.id === zone.id) {
        setSelectedZone(null);
      }
    } catch (error: any) {
      toast.error("Failed to disable DNSSEC: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const queueSigning = async (zone: DNSSECZone) => {
    setLoading(true);
    try {
      await apiRequest(`/dnssec/zones/${zone.id}/sign`, { method: "POST" });
      toast.success(`Zone ${zone.origin} queued for signing`);
      loadQueue();
    } catch (error: any) {
      toast.error("Failed to queue signing: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const deactivateKey = async (key: DNSSECKey) => {
    if (!confirm(`Are you sure you want to deactivate key ${key.key_tag}?`)) {
      return;
    }

    setLoading(true);
    try {
      await apiRequest(`/dnssec/keys/${key.id}`, { method: "DELETE" });
      toast.success(`Key ${key.key_tag} deactivated`);
      if (selectedZone) {
        loadKeys(selectedZone.id);
      }
    } catch (error: any) {
      toast.error("Failed to deactivate key: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const generateKey = async () => {
    if (!selectedZone) return;

    setLoading(true);
    try {
      const algo = parseInt(keyGenAlgorithm);
      const keySize = (algo === 8 || algo === 10) ? parseInt(keyGenKeySize) : null;

      await apiRequest(`/dnssec/keys/${selectedZone.id}/generate`, {
        method: "POST",
        body: JSON.stringify({
          algorithm: algo,
          key_size: keySize,
          is_ksk: keyGenIsKSK,
        }),
      });

      toast.success(`${keyGenIsKSK ? 'KSK' : 'ZSK'} key generated successfully`);
      setKeyGenDialogOpen(false);
      loadKeys(selectedZone.id);
      loadZones();
    } catch (error: any) {
      toast.error("Failed to generate key: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (zone: DNSSECZone) => {
    if (!zone.dnssec_enabled) {
      return <Badge variant="outline" className="bg-gray-100">Disabled</Badge>;
    }
    if (zone.active_keys === 0) {
      return <Badge variant="outline" className="bg-yellow-100 text-yellow-800">No Keys</Badge>;
    }
    if (zone.signature_count === 0) {
      return <Badge variant="outline" className="bg-yellow-100 text-yellow-800">Unsigned</Badge>;
    }
    return <Badge variant="outline" className="bg-green-100 text-green-800">Active</Badge>;
  };

  const getQueueStatusIcon = (status: string) => {
    switch (status) {
      case "pending":
        return <Clock className="h-4 w-4 text-gray-500" />;
      case "processing":
        return <RefreshCw className="h-4 w-4 text-blue-500 animate-spin" />;
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "failed":
        return <XCircle className="h-4 w-4 text-red-500" />;
      default:
        return <AlertCircle className="h-4 w-4 text-gray-500" />;
    }
  };

  return (
    <Layout user={user} onLogout={onLogout}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Shield className="h-8 w-8 text-blue-600" />
              DNSSEC Management
            </h1>
            <p className="text-gray-600 mt-1">Manage DNSSEC signing and keys for your zones</p>
          </div>
        </div>

        {/* Info Banner */}
        <Card className="bg-blue-50 border-blue-200">
          <CardContent className="pt-6">
            <div className="flex gap-3">
              <Info className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm space-y-1">
                <p className="font-semibold text-blue-900">DNSSEC Implementation Status: 80% Complete</p>
                <p className="text-blue-800">
                  Core infrastructure is ready. Key generation via web UI is pending - use <code className="bg-blue-100 px-1 rounded">dnssec-keygen</code> for now.
                  Automatic signing worker is not yet implemented - use manual signing via queue.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Zones List */}
        <Card>
          <CardHeader>
            <CardTitle>Zones</CardTitle>
            <CardDescription>Select a zone to view keys and manage DNSSEC</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Zone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Algorithm</TableHead>
                  <TableHead>NSEC Mode</TableHead>
                  <TableHead>Keys</TableHead>
                  <TableHead>Signatures</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {zones.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-gray-500">
                      No zones found
                    </TableCell>
                  </TableRow>
                ) : (
                  zones.map((zone) => (
                    <TableRow
                      key={zone.id}
                      className={`cursor-pointer hover:bg-gray-50 ${selectedZone?.id === zone.id ? "bg-blue-50" : ""}`}
                      onClick={() => setSelectedZone(zone)}
                    >
                      <TableCell className="font-medium">{zone.origin}</TableCell>
                      <TableCell>{getStatusBadge(zone)}</TableCell>
                      <TableCell>
                        {zone.preferred_algorithm ? ALGORITHM_NAMES[zone.preferred_algorithm] || `Algorithm ${zone.preferred_algorithm}` : "-"}
                      </TableCell>
                      <TableCell>{zone.nsec_mode || "-"}</TableCell>
                      <TableCell>{zone.active_keys}</TableCell>
                      <TableCell>{zone.signature_count}</TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          {!zone.dnssec_enabled ? (
                            <Dialog open={enableDialogOpen} onOpenChange={setEnableDialogOpen}>
                              <DialogTrigger asChild>
                                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); }}>
                                  <Shield className="h-3 w-3 mr-1" />
                                  Enable
                                </Button>
                              </DialogTrigger>
                              <DialogContent onClick={(e) => e.stopPropagation()}>
                                <DialogHeader>
                                  <DialogTitle>Enable DNSSEC for {zone.origin}</DialogTitle>
                                  <DialogDescription>
                                    Configure DNSSEC settings for this zone
                                  </DialogDescription>
                                </DialogHeader>
                                <div className="space-y-4 py-4">
                                  <div className="space-y-2">
                                    <Label>Algorithm</Label>
                                    <Select value={selectedAlgorithm} onValueChange={setSelectedAlgorithm}>
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="13">ECDSAP256SHA256 (Recommended)</SelectItem>
                                        <SelectItem value="15">ED25519 (Fast)</SelectItem>
                                        <SelectItem value="8">RSASHA256</SelectItem>
                                        <SelectItem value="10">RSASHA512</SelectItem>
                                        <SelectItem value="14">ECDSAP384SHA384</SelectItem>
                                        <SelectItem value="16">ED448</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-2">
                                    <Label>NSEC Mode</Label>
                                    <Select value={selectedNsecMode} onValueChange={setSelectedNsecMode}>
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="NSEC3">NSEC3 (Recommended - prevents zone enumeration)</SelectItem>
                                        <SelectItem value="NSEC">NSEC (Classic)</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <Label>Auto-sign on changes</Label>
                                    <Switch checked={autoSign} onCheckedChange={setAutoSign} />
                                  </div>
                                </div>
                                <DialogFooter>
                                  <Button variant="outline" onClick={(e) => { e.stopPropagation(); setEnableDialogOpen(false); }}>
                                    Cancel
                                  </Button>
                                  <Button onClick={(e) => { e.stopPropagation(); enableDNSSEC(zone); }} disabled={loading}>
                                    Enable DNSSEC
                                  </Button>
                                </DialogFooter>
                              </DialogContent>
                            </Dialog>
                          ) : (
                            <Fragment>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => { e.stopPropagation(); queueSigning(zone); }}
                                disabled={loading || zone.active_keys === 0}
                              >
                                <Play className="h-3 w-3 mr-1" />
                                Sign
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => { e.stopPropagation(); disableDNSSEC(zone); }}
                                disabled={loading}
                              >
                                Disable
                              </Button>
                            </Fragment>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Selected Zone Details */}
        {selectedZone && selectedZone.dnssec_enabled && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Keys */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Key className="h-5 w-5" />
                      Keys for {selectedZone.origin}
                    </CardTitle>
                    <CardDescription>
                      DNSSEC keys (KSK and ZSK)
                    </CardDescription>
                  </div>
                  <Dialog open={keyGenDialogOpen} onOpenChange={setKeyGenDialogOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm">
                        <Key className="h-3 w-3 mr-1" />
                        Generate Key
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Generate DNSSEC Key</DialogTitle>
                        <DialogDescription>
                          Generate a new key for {selectedZone.origin}
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Key Type</Label>
                          <Select value={keyGenIsKSK ? "ksk" : "zsk"} onValueChange={(v) => setKeyGenIsKSK(v === "ksk")}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="zsk">ZSK (Zone Signing Key)</SelectItem>
                              <SelectItem value="ksk">KSK (Key Signing Key)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Algorithm</Label>
                          <Select value={keyGenAlgorithm} onValueChange={setKeyGenAlgorithm}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="13">ECDSAP256SHA256 (Recommended)</SelectItem>
                              <SelectItem value="15">ED25519 (Fast)</SelectItem>
                              <SelectItem value="8">RSASHA256</SelectItem>
                              <SelectItem value="10">RSASHA512</SelectItem>
                              <SelectItem value="14">ECDSAP384SHA384</SelectItem>
                              <SelectItem value="16">ED448</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {(keyGenAlgorithm === "8" || keyGenAlgorithm === "10") && (
                          <div className="space-y-2">
                            <Label>Key Size (RSA only)</Label>
                            <Select value={keyGenKeySize} onValueChange={setKeyGenKeySize}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="2048">2048 bits</SelectItem>
                                <SelectItem value="3072">3072 bits</SelectItem>
                                <SelectItem value="4096">4096 bits</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setKeyGenDialogOpen(false)}>
                          Cancel
                        </Button>
                        <Button onClick={generateKey} disabled={loading}>
                          Generate Key
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent>
                {keys.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <Key className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                    <p>No keys found</p>
                    <p className="text-sm mt-1">Generate keys using dnssec-keygen and import them</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {keys.map((key) => (
                      <div key={key.id} className="border rounded-lg p-3">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant={key.is_ksk ? "default" : "outline"}>
                                {key.is_ksk ? "KSK" : "ZSK"}
                              </Badge>
                              <Badge variant={key.active ? "outline" : "destructive"} className={key.active ? "bg-green-100 text-green-800" : ""}>
                                {key.active ? "Active" : "Inactive"}
                              </Badge>
                              <span className="text-sm font-mono text-gray-600">Tag: {key.key_tag}</span>
                            </div>
                            <div className="text-sm text-gray-600">
                              <div>Algorithm: {ALGORITHM_NAMES[key.algorithm] || `Algorithm ${key.algorithm}`}</div>
                              <div>Created: {new Date(key.created_at).toLocaleDateString()}</div>
                              {key.expires_at && (
                                <div className={new Date(key.expires_at) < new Date() ? "text-red-600 font-semibold" : ""}>
                                  Expires: {new Date(key.expires_at).toLocaleDateString()}
                                </div>
                              )}
                            </div>
                          </div>
                          {key.active && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => deactivateKey(key)}
                              disabled={loading}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Logs */}
            <Card>
              <CardHeader>
                <CardTitle>Activity Log</CardTitle>
                <CardDescription>Recent DNSSEC operations for this zone</CardDescription>
              </CardHeader>
              <CardContent>
                {logs.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">No logs found</div>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {logs.map((log) => (
                      <div key={log.id} className="border-l-2 pl-3 py-2 text-sm" style={{ borderColor: log.success ? "#22c55e" : "#ef4444" }}>
                        <div className="flex items-start gap-2">
                          {log.success ? (
                            <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-900">{log.operation}</div>
                            <div className="text-gray-600 break-words">{log.message}</div>
                            <div className="text-xs text-gray-400 mt-1">
                              {new Date(log.timestamp).toLocaleString()}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Signing Queue */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Signing Queue
            </CardTitle>
            <CardDescription>Zones queued for DNSSEC signing</CardDescription>
          </CardHeader>
          <CardContent>
            {queue.length === 0 ? (
              <div className="text-center py-8 text-gray-500">No zones in signing queue</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Zone</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {getQueueStatusIcon(item.status)}
                          <span className="capitalize">{item.status}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">{item.origin}</TableCell>
                      <TableCell>{item.reason}</TableCell>
                      <TableCell>{item.priority}</TableCell>
                      <TableCell className="text-sm text-gray-600">
                        {new Date(item.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm text-red-600">
                        {item.error_message || "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
