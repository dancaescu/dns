import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
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
  getLoadBalancerPoolsHealth,
} from "../lib/api";
import { RECORD_TYPE_LIST, RECORD_TYPES, TTL_OPTIONS, getTTLLabel } from "../lib/recordTypes";
import { toast, ToastContainer } from "../components/ui/toast";
import { TagInput } from "../components/ui/tag-input";
import { SyncModal, SyncMode } from "../components/SyncModal";
import { LoadBalancerEditor } from "../components/LoadBalancerEditor";
import { HealthStatusBadge } from "../components/HealthStatusBadge";
import { UnifiedHeader } from "../components/UnifiedHeader";

interface User {
  id: number;
  username: string;
  email: string;
  role: "superadmin" | "account_admin" | "user";
}

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
  pool_count?: number;
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
  // CERT record structured data
  certType: 0,
  certKeyTag: 0,
  certAlgorithm: 0,
  certCertificate: "",
  // CAA record structured data
  caaFlags: 0,
  caaTag: "issue",
  caaValue: "",
  // DNSKEY record structured data
  dnskeyFlags: 257,
  dnskeyProtocol: 3,
  dnskeyAlgorithm: 8,
  dnskeyPublicKey: "",
  // SMIMEA record structured data
  smimeaUsage: 3,
  smimeaSelector: 1,
  smimeaMatchingType: 1,
  smimeaCertificate: "",
  // SSHFP record structured data
  sshfpAlgorithm: 1,
  sshfpFptype: 2,
  sshfpFingerprint: "",
};

// Validate IPv4 address for A records
function validateIPv4(value: string): { valid: boolean; error?: string } {
  if (!value) {
    return { valid: false, error: 'IPv4 address is required' };
  }

  // IPv4 regex pattern
  const ipv4Pattern = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  if (!ipv4Pattern.test(value)) {
    return { valid: false, error: 'Invalid IPv4 address. Format: xxx.xxx.xxx.xxx (e.g., 192.168.1.1)' };
  }

  return { valid: true };
}

// Validate IPv6 address for AAAA records
function validateIPv6(value: string): { valid: boolean; error?: string } {
  if (!value) {
    return { valid: false, error: 'IPv6 address is required' };
  }

  // IPv6 regex pattern (supports full and compressed formats)
  const ipv6Pattern = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

  if (!ipv6Pattern.test(value)) {
    return { valid: false, error: 'Invalid IPv6 address. Format: xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx (e.g., 2001:db8::1)' };
  }

  return { valid: true };
}

// Validate domain name for CNAME, MX, NS records
function validateDomainName(value: string): { valid: boolean; error?: string } {
  if (!value) {
    return { valid: false, error: 'Domain name is required' };
  }

  // Remove trailing dot for validation
  const name = value.endsWith('.') ? value.slice(0, -1) : value;

  // Check for invalid characters - allow underscores for DKIM and other TXT records
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return { valid: false, error: 'Invalid domain name. Use only letters, numbers, dots, hyphens, and underscores.' };
  }

  // Check each label
  const labels = name.split('.');
  for (const label of labels) {
    if (!label) {
      return { valid: false, error: 'Domain name contains empty labels (consecutive dots)' };
    }
    if (label.length > 63) {
      return { valid: false, error: 'Domain name has a label longer than 63 characters' };
    }
    // Allow hyphens and underscores in the middle of labels
    if (label.startsWith('-') || label.endsWith('-')) {
      return { valid: false, error: 'Domain name labels cannot start or end with hyphen' };
    }
  }

  return { valid: true };
}

// Validate base64 encoding
function validateBase64(value: string): { valid: boolean; error?: string } {
  if (!value || value.trim() === '') {
    return { valid: false, error: 'Certificate data is required' };
  }

  // Remove whitespace and newlines
  const cleaned = value.replace(/\s/g, '');

  // Base64 regex pattern
  const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;

  if (!base64Pattern.test(cleaned)) {
    return { valid: false, error: 'Certificate must be valid base64 encoded data (A-Z, a-z, 0-9, +, /, =)' };
  }

  // Check length is multiple of 4 (base64 requirement)
  if (cleaned.length % 4 !== 0) {
    return { valid: false, error: 'Invalid base64 encoding (length must be multiple of 4)' };
  }

  return { valid: true };
}

// Validate hexadecimal string
function validateHex(value: string): { valid: boolean; error?: string } {
  if (!value || value.trim() === '') {
    return { valid: false, error: 'Hexadecimal data is required' };
  }

  const cleaned = value.replace(/\s/g, '');
  const hexPattern = /^[0-9a-fA-F]+$/;

  if (!hexPattern.test(cleaned)) {
    return { valid: false, error: 'Must be valid hexadecimal (0-9, A-F)' };
  }

  return { valid: true };
}

// Validate record content based on record type
function validateRecordContent(type: string, value: string, certData?: any): { valid: boolean; error?: string } {
  // Block record types not supported by Cloudflare API
  const cloudflareUnsupportedTypes = ['HINFO', 'RP'];
  if (cloudflareUnsupportedTypes.includes(type)) {
    return {
      valid: false,
      error: `${type} records are not supported by Cloudflare's API. This record type cannot be created.`
    };
  }

  // Block complex structured record types that need special form fields (except CERT, CAA, DNSKEY, SMIMEA, SSHFP which we support)
  const unsupportedTypes = ['DS', 'TLSA'];
  if (unsupportedTypes.includes(type)) {
    return {
      valid: false,
      error: `${type} records require structured data fields which are not yet supported in this interface. Please use Cloudflare dashboard or API directly.`
    };
  }

  // CERT record validation
  if (type === 'CERT') {
    if (!certData) {
      return { valid: false, error: 'CERT record data is required' };
    }

    // Validate Type field (must be a valid option)
    const validTypes = [0, 1, 2, 3, 253, 254, 255];
    if (!validTypes.includes(Number(certData.certType))) {
      return { valid: false, error: 'Invalid certificate type. Select from dropdown.' };
    }

    // Validate Key Tag (0-65535)
    const keyTag = Number(certData.certKeyTag);
    if (!Number.isInteger(keyTag) || keyTag < 0 || keyTag > 65535) {
      return { valid: false, error: 'Key Tag must be an integer between 0 and 65535' };
    }

    // Validate Algorithm (must be a valid option)
    const validAlgorithms = [0, 1, 2, 3, 5, 6, 7, 8, 10, 12, 13, 14, 15, 16, 253, 254, 255];
    if (!validAlgorithms.includes(Number(certData.certAlgorithm))) {
      return { valid: false, error: 'Invalid algorithm. Select from dropdown.' };
    }

    // Validate certificate base64 encoding
    const base64Validation = validateBase64(certData.certCertificate);
    if (!base64Validation.valid) {
      return base64Validation;
    }

    return { valid: true };
  }

  // CAA record validation
  if (type === 'CAA') {
    if (!certData) {
      return { valid: false, error: 'CAA record data is required' };
    }

    // Validate Flags (0 or 128)
    const flags = Number(certData.caaFlags);
    if (flags !== 0 && flags !== 128) {
      return { valid: false, error: 'Flags must be 0 (non-critical) or 128 (critical)' };
    }

    // Validate Tag
    const validTags = ['issue', 'issuewild', 'iodef'];
    if (!validTags.includes(certData.caaTag)) {
      return { valid: false, error: 'Invalid tag. Select from dropdown.' };
    }

    // Validate Value
    if (!certData.caaValue || certData.caaValue.trim() === '') {
      return { valid: false, error: 'Value field is required for CAA records' };
    }

    return { valid: true };
  }

  // DNSKEY record validation
  if (type === 'DNSKEY') {
    if (!certData) {
      return { valid: false, error: 'DNSKEY record data is required' };
    }

    // Validate Flags
    const validFlags = [0, 256, 257];
    if (!validFlags.includes(Number(certData.dnskeyFlags))) {
      return { valid: false, error: 'Invalid flags. Select from dropdown.' };
    }

    // Validate Protocol (must always be 3)
    if (Number(certData.dnskeyProtocol) !== 3) {
      return { valid: false, error: 'Protocol must be 3 for DNSSEC' };
    }

    // Validate Algorithm (must be a valid option)
    const validAlgorithms = [0, 1, 2, 3, 5, 6, 7, 8, 10, 12, 13, 14, 15, 16, 253, 254, 255];
    if (!validAlgorithms.includes(Number(certData.dnskeyAlgorithm))) {
      return { valid: false, error: 'Invalid algorithm. Select from dropdown.' };
    }

    // Validate public key base64 encoding
    const base64Validation = validateBase64(certData.dnskeyPublicKey);
    if (!base64Validation.valid) {
      return base64Validation;
    }

    return { valid: true };
  }

  // SMIMEA record validation
  if (type === 'SMIMEA') {
    if (!certData) {
      return { valid: false, error: 'SMIMEA record data is required' };
    }

    // Validate Usage (0-3)
    const usage = Number(certData.smimeaUsage);
    if (![0, 1, 2, 3].includes(usage)) {
      return { valid: false, error: 'Invalid usage. Select from dropdown.' };
    }

    // Validate Selector (0-1)
    const selector = Number(certData.smimeaSelector);
    if (![0, 1].includes(selector)) {
      return { valid: false, error: 'Invalid selector. Select from dropdown.' };
    }

    // Validate Matching Type (0-2)
    const matchingType = Number(certData.smimeaMatchingType);
    if (![0, 1, 2].includes(matchingType)) {
      return { valid: false, error: 'Invalid matching type. Select from dropdown.' };
    }

    // Validate certificate base64/hex encoding
    const certValidation = validateBase64(certData.smimeaCertificate);
    if (!certValidation.valid) {
      return certValidation;
    }

    return { valid: true };
  }

  // SSHFP record validation
  if (type === 'SSHFP') {
    if (!certData) {
      return { valid: false, error: 'SSHFP record data is required' };
    }

    // Validate Algorithm (1-4)
    const algorithm = Number(certData.sshfpAlgorithm);
    if (![1, 2, 3, 4].includes(algorithm)) {
      return { valid: false, error: 'Invalid algorithm. Select from dropdown.' };
    }

    // Validate Fingerprint Type (1-2)
    const fptype = Number(certData.sshfpFptype);
    if (![1, 2].includes(fptype)) {
      return { valid: false, error: 'Invalid fingerprint type. Select from dropdown.' };
    }

    // Validate fingerprint hexadecimal encoding
    const fpValidation = validateHex(certData.sshfpFingerprint);
    if (!fpValidation.valid) {
      return fpValidation;
    }

    return { valid: true };
  }

  switch (type) {
    case 'A':
      return validateIPv4(value);
    case 'AAAA':
      return validateIPv6(value);
    case 'CNAME':
    case 'MX':
    case 'NS':
      return validateDomainName(value);
    case 'OPENPGPKEY':
      // OPENPGPKEY requires valid base64 encoded public key
      const openpgpValidation = validateBase64(value);
      if (!openpgpValidation.valid) {
        return { valid: false, error: 'OPENPGPKEY content must be valid base64 encoded OpenPGP public key data' };
      }
      return { valid: true };
    case 'TXT':
      // TXT records have no validation constraints
      return { valid: true };
    default:
      // For other record types, just ensure value is not empty
      if (!value) {
        return { valid: false, error: 'Content is required' };
      }
      return { valid: true };
  }
}

export function CloudflareZonePage({ onLogout, user }: { onLogout: () => void; user: User | null }) {
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
  const [lbHealthData, setLbHealthData] = useState<Map<number, any>>(new Map());
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

  // Fetch health data for all load balancers
  useEffect(() => {
    if (loadBalancers.length === 0) {
      setLbHealthData(new Map());
      return;
    }

    const fetchAllHealth = async () => {
      const healthMap = new Map();

      await Promise.all(
        loadBalancers.map(async (lb) => {
          try {
            const data = await getLoadBalancerPoolsHealth(lb.id);
            const pools = data.result || [];

            // Calculate overall health: healthy if all pools are healthy
            let overallHealthy = null;
            if (pools.length > 0) {
              const allHealthy = pools.every((p: any) => p.healthy === true);
              const anyHealthy = pools.some((p: any) => p.healthy === true);
              const anyUnhealthy = pools.some((p: any) => p.healthy === false);

              if (allHealthy) {
                overallHealthy = true;
              } else if (anyUnhealthy) {
                overallHealthy = false;
              }
            }

            healthMap.set(lb.id, { healthy: overallHealthy, pools });
          } catch (error) {
            console.error(`Failed to fetch health for LB ${lb.id}:`, error);
            healthMap.set(lb.id, { healthy: null, pools: [] });
          }
        })
      );

      setLbHealthData(healthMap);
    };

    fetchAllHealth();

    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchAllHealth, 30000);
    return () => clearInterval(interval);
  }, [loadBalancers]);

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

    // Validate content based on record type
    const contentValidation = validateRecordContent(recordForm.type, recordForm.content, recordForm);
    if (!contentValidation.valid) {
      toast.error(contentValidation.error || "Invalid content for this record type");
      return;
    }

    setRecordLoading(true);
    try {
      // Build the record payload
      const recordPayload: any = {
        type: recordForm.type,
        name: recordForm.name,
        ttl: Number(recordForm.ttl) || undefined,
        proxied: Boolean(recordForm.proxied),
        comment: recordForm.comment || undefined,
        tags: recordForm.tags || undefined,
      };

      // For CERT records, use structured data format
      if (recordForm.type === 'CERT') {
        recordPayload.data = {
          type: Number(recordForm.certType),
          key_tag: Number(recordForm.certKeyTag),
          algorithm: Number(recordForm.certAlgorithm),
          certificate: recordForm.certCertificate.replace(/\s/g, ''), // Remove all whitespace
        };
      } else if (recordForm.type === 'CAA') {
        // For CAA records, use structured data format
        recordPayload.data = {
          flags: Number(recordForm.caaFlags),
          tag: recordForm.caaTag,
          value: recordForm.caaValue,
        };
      } else if (recordForm.type === 'DNSKEY') {
        // For DNSKEY records, use structured data format
        recordPayload.data = {
          flags: Number(recordForm.dnskeyFlags),
          protocol: Number(recordForm.dnskeyProtocol),
          algorithm: Number(recordForm.dnskeyAlgorithm),
          public_key: recordForm.dnskeyPublicKey.replace(/\s/g, ''), // Remove all whitespace
        };
      } else if (recordForm.type === 'SMIMEA') {
        // For SMIMEA records, use structured data format
        recordPayload.data = {
          usage: Number(recordForm.smimeaUsage),
          selector: Number(recordForm.smimeaSelector),
          matching_type: Number(recordForm.smimeaMatchingType),
          certificate: recordForm.smimeaCertificate.replace(/\s/g, ''), // Remove all whitespace
        };
      } else if (recordForm.type === 'SSHFP') {
        // For SSHFP records, use structured data format
        recordPayload.data = {
          algorithm: Number(recordForm.sshfpAlgorithm),
          type: Number(recordForm.sshfpFptype),
          fingerprint: recordForm.sshfpFingerprint.replace(/\s/g, ''), // Remove all whitespace
        };
      } else {
        // For other records, use simple content field
        recordPayload.content = recordForm.content;
        if (recordForm.priority) {
          recordPayload.priority = Number(recordForm.priority);
        }
      }

      await createCloudflareRecord(
        numericZoneId,
        recordPayload,
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

    // For CERT records, parse the structured data
    let certData = {
      certType: 0,
      certKeyTag: 0,
      certAlgorithm: 0,
      certCertificate: "",
    };

    if (record.record_type === 'CERT' && record.content) {
      // Try to parse if content contains structured data as JSON
      try {
        const data = JSON.parse(record.content);
        certData = {
          certType: data.type || 0,
          certKeyTag: data.key_tag || 0,
          certAlgorithm: data.algorithm || 0,
          certCertificate: data.certificate || "",
        };
      } catch (e) {
        // If not JSON, content might be the certificate itself
        certData.certCertificate = record.content;
      }
    }

    // For CAA records, parse the structured data
    let caaData = {
      caaFlags: 0,
      caaTag: "issue",
      caaValue: "",
    };

    if (record.record_type === 'CAA' && record.content) {
      // Try to parse if content contains structured data as JSON
      try {
        const data = JSON.parse(record.content);
        caaData = {
          caaFlags: data.flags || 0,
          caaTag: data.tag || "issue",
          caaValue: data.value || "",
        };
      } catch (e) {
        // If not JSON, content might be the value itself
        caaData.caaValue = record.content;
      }
    }

    // For DNSKEY records, parse the structured data
    let dnskeyData = {
      dnskeyFlags: 257,
      dnskeyProtocol: 3,
      dnskeyAlgorithm: 8,
      dnskeyPublicKey: "",
    };

    if (record.record_type === 'DNSKEY' && record.content) {
      // Try to parse if content contains structured data as JSON
      try {
        const data = JSON.parse(record.content);
        dnskeyData = {
          dnskeyFlags: data.flags || 257,
          dnskeyProtocol: data.protocol || 3,
          dnskeyAlgorithm: data.algorithm || 8,
          dnskeyPublicKey: data.public_key || "",
        };
      } catch (e) {
        // If not JSON, content might be the public key itself
        dnskeyData.dnskeyPublicKey = record.content;
      }
    }

    // For SMIMEA records, parse the structured data
    let smimeaData = {
      smimeaUsage: 3,
      smimeaSelector: 1,
      smimeaMatchingType: 1,
      smimeaCertificate: "",
    };

    if (record.record_type === 'SMIMEA' && record.content) {
      // Try to parse if content contains structured data as JSON
      try {
        const data = JSON.parse(record.content);
        smimeaData = {
          smimeaUsage: data.usage || 3,
          smimeaSelector: data.selector || 1,
          smimeaMatchingType: data.matching_type || 1,
          smimeaCertificate: data.certificate || "",
        };
      } catch (e) {
        // If not JSON, content might be the certificate itself
        smimeaData.smimeaCertificate = record.content;
      }
    }

    // For SSHFP records, parse the structured data
    let sshfpData = {
      sshfpAlgorithm: 1,
      sshfpFptype: 2,
      sshfpFingerprint: "",
    };

    if (record.record_type === 'SSHFP' && record.content) {
      // Try to parse if content contains structured data as JSON
      try {
        const data = JSON.parse(record.content);
        sshfpData = {
          sshfpAlgorithm: data.algorithm || 1,
          sshfpFptype: data.type || 2,
          sshfpFingerprint: data.fingerprint || "",
        };
      } catch (e) {
        // If not JSON, content might be the fingerprint itself
        sshfpData.sshfpFingerprint = record.content;
      }
    }

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
      ...certData,
      ...caaData,
      ...dnskeyData,
      ...smimeaData,
      ...sshfpData,
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

    // Validate content based on record type
    const contentValidation = validateRecordContent(editForm.type, editForm.content, editForm);
    if (!contentValidation.valid) {
      toast.error(contentValidation.error || "Invalid content for this record type");
      return;
    }

    setRecordLoading(true);
    try {
      // Build the record payload
      const recordPayload: any = {
        type: editForm.type,
        name: editForm.name,
        ttl: Number(editForm.ttl) || undefined,
        proxied: Boolean(editForm.proxied),
        comment: editForm.comment || undefined,
        tags: editForm.tags || undefined,
      };

      // For CERT records, use structured data format
      if (editForm.type === 'CERT') {
        recordPayload.data = {
          type: Number(editForm.certType),
          key_tag: Number(editForm.certKeyTag),
          algorithm: Number(editForm.certAlgorithm),
          certificate: editForm.certCertificate.replace(/\s/g, ''), // Remove all whitespace
        };
      } else if (editForm.type === 'CAA') {
        // For CAA records, use structured data format
        recordPayload.data = {
          flags: Number(editForm.caaFlags),
          tag: editForm.caaTag,
          value: editForm.caaValue,
        };
      } else if (editForm.type === 'DNSKEY') {
        // For DNSKEY records, use structured data format
        recordPayload.data = {
          flags: Number(editForm.dnskeyFlags),
          protocol: Number(editForm.dnskeyProtocol),
          algorithm: Number(editForm.dnskeyAlgorithm),
          public_key: editForm.dnskeyPublicKey.replace(/\s/g, ''), // Remove all whitespace
        };
      } else if (editForm.type === 'SMIMEA') {
        // For SMIMEA records, use structured data format
        recordPayload.data = {
          usage: Number(editForm.smimeaUsage),
          selector: Number(editForm.smimeaSelector),
          matching_type: Number(editForm.smimeaMatchingType),
          certificate: editForm.smimeaCertificate.replace(/\s/g, ''), // Remove all whitespace
        };
      } else if (editForm.type === 'SSHFP') {
        // For SSHFP records, use structured data format
        recordPayload.data = {
          algorithm: Number(editForm.sshfpAlgorithm),
          type: Number(editForm.sshfpFptype),
          fingerprint: editForm.sshfpFingerprint.replace(/\s/g, ''), // Remove all whitespace
        };
      } else {
        // For other records, use simple content field
        recordPayload.content = editForm.content;
        if (editForm.priority) {
          recordPayload.priority = Number(editForm.priority);
        }
      }

      await updateCloudflareRecord(
        editingRecordId,
        recordPayload,
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

  async function handlePurgeCache() {
    if (!confirm("Are you sure you want to purge all cached content for this zone? This action cannot be undone.")) {
      return;
    }

    setRecordLoading(true);
    try {
      await apiRequest(`/cloudflare/zones/${numericZoneId}/purge-cache`, {
        method: "POST",
      });
      toast.success("Cache purged successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to purge cache";
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
      console.log("Fetched pools:", pools);

      // Fetch origins for each pool
      const poolsWithOrigins = await Promise.all(
        pools.map(async (pool: any) => {
          const poolDetail = await getPool(pool.id);
          console.log(`Pool ${pool.id} detail:`, poolDetail);
          return {
            ...pool,
            origins: poolDetail.origins || [],
          };
        })
      );

      console.log("Pools with origins:", poolsWithOrigins);

      setEditingLoadBalancer({
        ...lb,
        pools: poolsWithOrigins,
      });
      setShowLbEditor(true);
    } catch (error) {
      toast.error("Failed to load load balancer details");
      console.error("Error loading load balancer:", error);
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
      <UnifiedHeader
        title="Cloudflare Zone"
        subtitle={zone ? `${zone.name} · Account: ${zone.account_name || "Unknown"}` : undefined}
        showBackButton={true}
        onLogout={onLogout}
        user={user}
      />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {zone && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Zone Overview</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={handlePurgeCache}
                disabled={recordLoading}
                className="text-orange-600 hover:text-orange-700"
              >
                Purge Cache
              </Button>
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
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-blue-600">{lb.name}</p>
                          <HealthStatusBadge
                            healthy={lbHealthData.get(lb.id)?.healthy ?? null}
                            size="sm"
                          />
                        </div>
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
                          {lb.pool_count !== undefined && (
                            <span className="font-medium text-blue-600">
                              {lb.pool_count} {lb.pool_count === 1 ? 'pool' : 'pools'}
                            </span>
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
                  {recordForm.type !== 'CERT' && recordForm.type !== 'CAA' && recordForm.type !== 'DNSKEY' && recordForm.type !== 'SMIMEA' && recordForm.type !== 'SSHFP' && (
                    <div className="md:col-span-2">
                      <Label htmlFor="record-content" className="text-sm font-medium">
                        {(RECORD_TYPES[recordForm.type] || RECORD_TYPES.A).contentLabel} (required)
                        {recordForm.type === 'A' && ' - IPv4 address'}
                        {recordForm.type === 'AAAA' && ' - IPv6 address'}
                        {(recordForm.type === 'CNAME' || recordForm.type === 'MX' || recordForm.type === 'NS') && ' - Domain name'}
                      </Label>
                      {recordForm.type === 'TXT' ? (
                        <Textarea
                          id="record-content"
                          value={recordForm.content}
                          onChange={(e) => handleRecordFormChange("content", e.target.value)}
                          className="mt-1"
                          rows={3}
                          required
                        />
                      ) : (
                        <Input
                          id="record-content"
                          value={recordForm.content}
                          onChange={(e) => handleRecordFormChange("content", e.target.value)}
                          placeholder={
                            recordForm.type === 'A' ? 'e.g., 192.168.1.1' :
                            recordForm.type === 'AAAA' ? 'e.g., 2001:db8::1' :
                            (recordForm.type === 'CNAME' || recordForm.type === 'MX' || recordForm.type === 'NS') ? 'e.g., example.com' :
                            (RECORD_TYPES[recordForm.type] || RECORD_TYPES.A).contentPlaceholder
                          }
                          className="mt-1"
                          required
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* CERT record structured fields */}
                {recordForm.type === 'CERT' && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-4 border-t pt-4">
                    <div>
                      <Label htmlFor="cert-type" className="text-sm font-medium">Type *</Label>
                      <select
                        id="cert-type"
                        value={recordForm.certType}
                        onChange={(e) => handleRecordFormChange("certType", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="0">0 - Reserved</option>
                        <option value="1">1 - PKIX (X.509 certificate)</option>
                        <option value="2">2 - SPKI (Simple Public Key)</option>
                        <option value="3">3 - PGP (OpenPGP key)</option>
                        <option value="253">253 - Experimental</option>
                        <option value="254">254 - Experimental</option>
                        <option value="255">255 - Reserved</option>
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="cert-key-tag" className="text-sm font-medium">Key Tag *</Label>
                      <Input
                        id="cert-key-tag"
                        type="number"
                        min="0"
                        max="65535"
                        value={recordForm.certKeyTag}
                        onChange={(e) => handleRecordFormChange("certKeyTag", Number(e.target.value))}
                        className="mt-1"
                        required
                      />
                      <p className="mt-1 text-xs text-gray-500">Integer: 0-65535</p>
                    </div>
                    <div>
                      <Label htmlFor="cert-algorithm" className="text-sm font-medium">Algorithm *</Label>
                      <select
                        id="cert-algorithm"
                        value={recordForm.certAlgorithm}
                        onChange={(e) => handleRecordFormChange("certAlgorithm", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="0">0 - Reserved</option>
                        <option value="1">1 - RSA/MD5 (deprecated)</option>
                        <option value="2">2 - Diffie-Hellman</option>
                        <option value="3">3 - DSA/SHA-1</option>
                        <option value="5">5 - RSA/SHA-1</option>
                        <option value="6">6 - DSA-NSEC3-SHA1</option>
                        <option value="7">7 - RSASHA1-NSEC3-SHA1</option>
                        <option value="8">8 - RSA/SHA-256</option>
                        <option value="10">10 - RSA/SHA-512</option>
                        <option value="12">12 - GOST R 34.10-2001</option>
                        <option value="13">13 - ECDSA/SHA-256</option>
                        <option value="14">14 - ECDSA/SHA-384</option>
                        <option value="15">15 - Ed25519</option>
                        <option value="16">16 - Ed448</option>
                        <option value="253">253 - Private algorithm</option>
                        <option value="254">254 - Private algorithm</option>
                        <option value="255">255 - Reserved</option>
                      </select>
                    </div>
                    <div className="md:col-span-4">
                      <Label htmlFor="cert-certificate" className="text-sm font-medium">Certificate (Base64) *</Label>
                      <Textarea
                        id="cert-certificate"
                        value={recordForm.certCertificate}
                        onChange={(e) => handleRecordFormChange("certCertificate", e.target.value)}
                        className="mt-1 font-mono text-xs"
                        rows={6}
                        placeholder="Base64 encoded certificate data (A-Z, a-z, 0-9, +, /, =)"
                        required
                      />
                      <p className="mt-1 text-xs text-gray-500">Only valid base64 characters allowed. Whitespace will be removed.</p>
                    </div>
                  </div>
                )}

                {/* CAA record structured fields */}
                {recordForm.type === 'CAA' && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3 border-t pt-4">
                    <div>
                      <Label htmlFor="caa-flags" className="text-sm font-medium">Flags *</Label>
                      <select
                        id="caa-flags"
                        value={recordForm.caaFlags}
                        onChange={(e) => handleRecordFormChange("caaFlags", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="0">0 - Non-critical</option>
                        <option value="128">128 - Critical (issuer must understand tag)</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">Critical flag enforces tag understanding</p>
                    </div>
                    <div>
                      <Label htmlFor="caa-tag" className="text-sm font-medium">Tag *</Label>
                      <select
                        id="caa-tag"
                        value={recordForm.caaTag}
                        onChange={(e) => handleRecordFormChange("caaTag", e.target.value)}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="issue">issue - Authorize certificate issuance</option>
                        <option value="issuewild">issuewild - Authorize wildcard certificate issuance</option>
                        <option value="iodef">iodef - Report policy violations to URL</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">Property to control</p>
                    </div>
                    <div>
                      <Label htmlFor="caa-value" className="text-sm font-medium">Value *</Label>
                      <Input
                        id="caa-value"
                        value={recordForm.caaValue}
                        onChange={(e) => handleRecordFormChange("caaValue", e.target.value)}
                        className="mt-1"
                        placeholder="e.g., letsencrypt.org or mailto:admin@example.com"
                        required
                      />
                      <p className="mt-1 text-xs text-gray-500">CA domain or iodef URL</p>
                    </div>
                  </div>
                )}

                {/* DNSKEY record structured fields */}
                {recordForm.type === 'DNSKEY' && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-4 border-t pt-4">
                    <div>
                      <Label htmlFor="dnskey-flags" className="text-sm font-medium">Flags *</Label>
                      <select
                        id="dnskey-flags"
                        value={recordForm.dnskeyFlags}
                        onChange={(e) => handleRecordFormChange("dnskeyFlags", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="0">0 - Reserved</option>
                        <option value="256">256 - Zone Signing Key (ZSK)</option>
                        <option value="257">257 - Key Signing Key (KSK)</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">Key type</p>
                    </div>
                    <div>
                      <Label htmlFor="dnskey-protocol" className="text-sm font-medium">Protocol *</Label>
                      <Input
                        id="dnskey-protocol"
                        type="number"
                        value={3}
                        disabled
                        className="mt-1 bg-gray-100"
                      />
                      <p className="mt-1 text-xs text-gray-500">Always 3 for DNSSEC</p>
                    </div>
                    <div>
                      <Label htmlFor="dnskey-algorithm" className="text-sm font-medium">Algorithm *</Label>
                      <select
                        id="dnskey-algorithm"
                        value={recordForm.dnskeyAlgorithm}
                        onChange={(e) => handleRecordFormChange("dnskeyAlgorithm", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="0">0 - Reserved</option>
                        <option value="1">1 - RSA/MD5 (deprecated)</option>
                        <option value="2">2 - Diffie-Hellman</option>
                        <option value="3">3 - DSA/SHA-1</option>
                        <option value="5">5 - RSA/SHA-1</option>
                        <option value="6">6 - DSA-NSEC3-SHA1</option>
                        <option value="7">7 - RSASHA1-NSEC3-SHA1</option>
                        <option value="8">8 - RSA/SHA-256</option>
                        <option value="10">10 - RSA/SHA-512</option>
                        <option value="12">12 - GOST R 34.10-2001</option>
                        <option value="13">13 - ECDSA/SHA-256</option>
                        <option value="14">14 - ECDSA/SHA-384</option>
                        <option value="15">15 - Ed25519</option>
                        <option value="16">16 - Ed448</option>
                        <option value="253">253 - Private algorithm</option>
                        <option value="254">254 - Private algorithm</option>
                        <option value="255">255 - Reserved</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">Cryptographic algorithm</p>
                    </div>
                    <div className="md:col-span-4">
                      <Label htmlFor="dnskey-public-key" className="text-sm font-medium">Public Key (Base64) *</Label>
                      <Textarea
                        id="dnskey-public-key"
                        value={recordForm.dnskeyPublicKey}
                        onChange={(e) => handleRecordFormChange("dnskeyPublicKey", e.target.value)}
                        className="mt-1 font-mono text-xs"
                        rows={6}
                        placeholder="Base64 encoded public key data (A-Z, a-z, 0-9, +, /, =)"
                        required
                      />
                      <p className="mt-1 text-xs text-gray-500">Only valid base64 characters allowed. Whitespace will be removed.</p>
                    </div>
                  </div>
                )}

                {/* SMIMEA record structured fields */}
                {recordForm.type === 'SMIMEA' && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-4 border-t pt-4">
                    <div>
                      <Label htmlFor="smimea-usage" className="text-sm font-medium">Usage *</Label>
                      <select
                        id="smimea-usage"
                        value={recordForm.smimeaUsage}
                        onChange={(e) => handleRecordFormChange("smimeaUsage", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="0">0 - CA constraint</option>
                        <option value="1">1 - Service certificate constraint</option>
                        <option value="2">2 - Trust anchor assertion</option>
                        <option value="3">3 - Domain-issued certificate</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">Certificate usage</p>
                    </div>
                    <div>
                      <Label htmlFor="smimea-selector" className="text-sm font-medium">Selector *</Label>
                      <select
                        id="smimea-selector"
                        value={recordForm.smimeaSelector}
                        onChange={(e) => handleRecordFormChange("smimeaSelector", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="0">0 - Full certificate</option>
                        <option value="1">1 - SubjectPublicKeyInfo</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">What is matched</p>
                    </div>
                    <div>
                      <Label htmlFor="smimea-matching-type" className="text-sm font-medium">Matching Type *</Label>
                      <select
                        id="smimea-matching-type"
                        value={recordForm.smimeaMatchingType}
                        onChange={(e) => handleRecordFormChange("smimeaMatchingType", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="0">0 - No hash</option>
                        <option value="1">1 - SHA-256</option>
                        <option value="2">2 - SHA-512</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">Hash algorithm</p>
                    </div>
                    <div className="md:col-span-4">
                      <Label htmlFor="smimea-certificate" className="text-sm font-medium">Certificate (Base64/Hex) *</Label>
                      <Textarea
                        id="smimea-certificate"
                        value={recordForm.smimeaCertificate}
                        onChange={(e) => handleRecordFormChange("smimeaCertificate", e.target.value)}
                        className="mt-1 font-mono text-xs"
                        rows={6}
                        placeholder="Base64 or hexadecimal encoded certificate data (A-Z, a-z, 0-9, +, /, =)"
                        required
                      />
                      <p className="mt-1 text-xs text-gray-500">Only valid base64/hex characters allowed. Whitespace will be removed.</p>
                    </div>
                  </div>
                )}

                {/* SSHFP record structured fields */}
                {recordForm.type === 'SSHFP' && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3 border-t pt-4">
                    <div>
                      <Label htmlFor="sshfp-algorithm" className="text-sm font-medium">Algorithm *</Label>
                      <select
                        id="sshfp-algorithm"
                        value={recordForm.sshfpAlgorithm}
                        onChange={(e) => handleRecordFormChange("sshfpAlgorithm", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="1">1 - RSA</option>
                        <option value="2">2 - DSS</option>
                        <option value="3">3 - ECDSA</option>
                        <option value="4">4 - Ed25519</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">SSH key algorithm</p>
                    </div>
                    <div>
                      <Label htmlFor="sshfp-fptype" className="text-sm font-medium">Fingerprint Type *</Label>
                      <select
                        id="sshfp-fptype"
                        value={recordForm.sshfpFptype}
                        onChange={(e) => handleRecordFormChange("sshfpFptype", Number(e.target.value))}
                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                        required
                      >
                        <option value="1">1 - SHA-1</option>
                        <option value="2">2 - SHA-256</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">Hash algorithm</p>
                    </div>
                    <div className="md:col-span-3">
                      <Label htmlFor="sshfp-fingerprint" className="text-sm font-medium">Fingerprint (Hex) *</Label>
                      <Textarea
                        id="sshfp-fingerprint"
                        value={recordForm.sshfpFingerprint}
                        onChange={(e) => handleRecordFormChange("sshfpFingerprint", e.target.value)}
                        className="mt-1 font-mono text-xs"
                        rows={3}
                        placeholder="Hexadecimal fingerprint (0-9, A-F)"
                        required
                      />
                      <p className="mt-1 text-xs text-gray-500">Only valid hexadecimal characters allowed. Whitespace will be removed.</p>
                    </div>
                  </div>
                )}

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
                                  {editForm.type !== 'CERT' && editForm.type !== 'CAA' && editForm.type !== 'DNSKEY' && editForm.type !== 'SMIMEA' && editForm.type !== 'SSHFP' && (
                                    <div className="md:col-span-2">
                                      <Label htmlFor="edit-content" className="text-sm font-medium">
                                        {recordTypeConfig.contentLabel} (required)
                                        {editForm.type === 'A' && ' - IPv4 address'}
                                        {editForm.type === 'AAAA' && ' - IPv6 address'}
                                        {(editForm.type === 'CNAME' || editForm.type === 'MX' || editForm.type === 'NS') && ' - Domain name'}
                                      </Label>
                                      {editForm.type === 'TXT' ? (
                                        <Textarea
                                          id="edit-content"
                                          value={editForm.content}
                                          onChange={(e) => handleEditFormChange("content", e.target.value)}
                                          className="mt-1"
                                          rows={3}
                                          required
                                        />
                                      ) : (
                                        <Input
                                          id="edit-content"
                                          value={editForm.content}
                                          onChange={(e) => handleEditFormChange("content", e.target.value)}
                                          placeholder={
                                            editForm.type === 'A' ? 'e.g., 192.168.1.1' :
                                            editForm.type === 'AAAA' ? 'e.g., 2001:db8::1' :
                                            (editForm.type === 'CNAME' || editForm.type === 'MX' || editForm.type === 'NS') ? 'e.g., example.com' :
                                            recordTypeConfig.contentPlaceholder
                                          }
                                          className="mt-1"
                                          required
                                        />
                                      )}
                                    </div>
                                  )}
                                </div>

                                {/* CERT record structured fields for edit */}
                                {editForm.type === 'CERT' && (
                                  <div className="grid grid-cols-1 gap-4 md:grid-cols-4 border-t pt-4">
                                    <div>
                                      <Label htmlFor="edit-cert-type" className="text-sm font-medium">Type *</Label>
                                      <select
                                        id="edit-cert-type"
                                        value={editForm.certType}
                                        onChange={(e) => handleEditFormChange("certType", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="0">0 - Reserved</option>
                                        <option value="1">1 - PKIX (X.509 certificate)</option>
                                        <option value="2">2 - SPKI (Simple Public Key)</option>
                                        <option value="3">3 - PGP (OpenPGP key)</option>
                                        <option value="253">253 - Experimental</option>
                                        <option value="254">254 - Experimental</option>
                                        <option value="255">255 - Reserved</option>
                                      </select>
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-cert-key-tag" className="text-sm font-medium">Key Tag *</Label>
                                      <Input
                                        id="edit-cert-key-tag"
                                        type="number"
                                        min="0"
                                        max="65535"
                                        value={editForm.certKeyTag}
                                        onChange={(e) => handleEditFormChange("certKeyTag", Number(e.target.value))}
                                        className="mt-1"
                                        required
                                      />
                                      <p className="mt-1 text-xs text-gray-500">Integer: 0-65535</p>
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-cert-algorithm" className="text-sm font-medium">Algorithm *</Label>
                                      <select
                                        id="edit-cert-algorithm"
                                        value={editForm.certAlgorithm}
                                        onChange={(e) => handleEditFormChange("certAlgorithm", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="0">0 - Reserved</option>
                                        <option value="1">1 - RSA/MD5 (deprecated)</option>
                                        <option value="2">2 - Diffie-Hellman</option>
                                        <option value="3">3 - DSA/SHA-1</option>
                                        <option value="5">5 - RSA/SHA-1</option>
                                        <option value="6">6 - DSA-NSEC3-SHA1</option>
                                        <option value="7">7 - RSASHA1-NSEC3-SHA1</option>
                                        <option value="8">8 - RSA/SHA-256</option>
                                        <option value="10">10 - RSA/SHA-512</option>
                                        <option value="12">12 - GOST R 34.10-2001</option>
                                        <option value="13">13 - ECDSA/SHA-256</option>
                                        <option value="14">14 - ECDSA/SHA-384</option>
                                        <option value="15">15 - Ed25519</option>
                                        <option value="16">16 - Ed448</option>
                                        <option value="253">253 - Private algorithm</option>
                                        <option value="254">254 - Private algorithm</option>
                                        <option value="255">255 - Reserved</option>
                                      </select>
                                    </div>
                                    <div className="md:col-span-4">
                                      <Label htmlFor="edit-cert-certificate" className="text-sm font-medium">Certificate (Base64) *</Label>
                                      <Textarea
                                        id="edit-cert-certificate"
                                        value={editForm.certCertificate}
                                        onChange={(e) => handleEditFormChange("certCertificate", e.target.value)}
                                        className="mt-1 font-mono text-xs"
                                        rows={6}
                                        placeholder="Base64 encoded certificate data (A-Z, a-z, 0-9, +, /, =)"
                                        required
                                      />
                                      <p className="mt-1 text-xs text-gray-500">Only valid base64 characters allowed. Whitespace will be removed.</p>
                                    </div>
                                  </div>
                                )}

                                {/* CAA record structured fields for edit */}
                                {editForm.type === 'CAA' && (
                                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3 border-t pt-4">
                                    <div>
                                      <Label htmlFor="edit-caa-flags" className="text-sm font-medium">Flags *</Label>
                                      <select
                                        id="edit-caa-flags"
                                        value={editForm.caaFlags}
                                        onChange={(e) => handleEditFormChange("caaFlags", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="0">0 - Non-critical</option>
                                        <option value="128">128 - Critical (issuer must understand tag)</option>
                                      </select>
                                      <p className="mt-1 text-xs text-gray-500">Critical flag enforces tag understanding</p>
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-caa-tag" className="text-sm font-medium">Tag *</Label>
                                      <select
                                        id="edit-caa-tag"
                                        value={editForm.caaTag}
                                        onChange={(e) => handleEditFormChange("caaTag", e.target.value)}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="issue">issue - Authorize certificate issuance</option>
                                        <option value="issuewild">issuewild - Authorize wildcard certificate issuance</option>
                                        <option value="iodef">iodef - Report policy violations to URL</option>
                                      </select>
                                      <p className="mt-1 text-xs text-gray-500">Property to control</p>
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-caa-value" className="text-sm font-medium">Value *</Label>
                                      <Input
                                        id="edit-caa-value"
                                        value={editForm.caaValue}
                                        onChange={(e) => handleEditFormChange("caaValue", e.target.value)}
                                        className="mt-1"
                                        placeholder="e.g., letsencrypt.org or mailto:admin@example.com"
                                        required
                                      />
                                      <p className="mt-1 text-xs text-gray-500">CA domain or iodef URL</p>
                                    </div>
                                  </div>
                                )}

                                {/* DNSKEY record structured fields for edit */}
                                {editForm.type === 'DNSKEY' && (
                                  <div className="grid grid-cols-1 gap-4 md:grid-cols-4 border-t pt-4">
                                    <div>
                                      <Label htmlFor="edit-dnskey-flags" className="text-sm font-medium">Flags *</Label>
                                      <select
                                        id="edit-dnskey-flags"
                                        value={editForm.dnskeyFlags}
                                        onChange={(e) => handleEditFormChange("dnskeyFlags", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="0">0 - Reserved</option>
                                        <option value="256">256 - Zone Signing Key (ZSK)</option>
                                        <option value="257">257 - Key Signing Key (KSK)</option>
                                      </select>
                                      <p className="mt-1 text-xs text-gray-500">Key type</p>
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-dnskey-protocol" className="text-sm font-medium">Protocol *</Label>
                                      <Input
                                        id="edit-dnskey-protocol"
                                        type="number"
                                        value={3}
                                        disabled
                                        className="mt-1 bg-gray-100"
                                      />
                                      <p className="mt-1 text-xs text-gray-500">Always 3 for DNSSEC</p>
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-dnskey-algorithm" className="text-sm font-medium">Algorithm *</Label>
                                      <select
                                        id="edit-dnskey-algorithm"
                                        value={editForm.dnskeyAlgorithm}
                                        onChange={(e) => handleEditFormChange("dnskeyAlgorithm", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="0">0 - Reserved</option>
                                        <option value="1">1 - RSA/MD5 (deprecated)</option>
                                        <option value="2">2 - Diffie-Hellman</option>
                                        <option value="3">3 - DSA/SHA-1</option>
                                        <option value="5">5 - RSA/SHA-1</option>
                                        <option value="6">6 - DSA-NSEC3-SHA1</option>
                                        <option value="7">7 - RSASHA1-NSEC3-SHA1</option>
                                        <option value="8">8 - RSA/SHA-256</option>
                                        <option value="10">10 - RSA/SHA-512</option>
                                        <option value="12">12 - GOST R 34.10-2001</option>
                                        <option value="13">13 - ECDSA/SHA-256</option>
                                        <option value="14">14 - ECDSA/SHA-384</option>
                                        <option value="15">15 - Ed25519</option>
                                        <option value="16">16 - Ed448</option>
                                        <option value="253">253 - Private algorithm</option>
                                        <option value="254">254 - Private algorithm</option>
                                        <option value="255">255 - Reserved</option>
                                      </select>
                                      <p className="mt-1 text-xs text-gray-500">Cryptographic algorithm</p>
                                    </div>
                                    <div className="md:col-span-4">
                                      <Label htmlFor="edit-dnskey-public-key" className="text-sm font-medium">Public Key (Base64) *</Label>
                                      <Textarea
                                        id="edit-dnskey-public-key"
                                        value={editForm.dnskeyPublicKey}
                                        onChange={(e) => handleEditFormChange("dnskeyPublicKey", e.target.value)}
                                        className="mt-1 font-mono text-xs"
                                        rows={6}
                                        placeholder="Base64 encoded public key data (A-Z, a-z, 0-9, +, /, =)"
                                        required
                                      />
                                      <p className="mt-1 text-xs text-gray-500">Only valid base64 characters allowed. Whitespace will be removed.</p>
                                    </div>
                                  </div>
                                )}

                                {/* SMIMEA record structured fields for edit */}
                                {editForm.type === 'SMIMEA' && (
                                  <div className="grid grid-cols-1 gap-4 md:grid-cols-4 border-t pt-4">
                                    <div>
                                      <Label htmlFor="edit-smimea-usage" className="text-sm font-medium">Usage *</Label>
                                      <select
                                        id="edit-smimea-usage"
                                        value={editForm.smimeaUsage}
                                        onChange={(e) => handleEditFormChange("smimeaUsage", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="0">0 - CA constraint</option>
                                        <option value="1">1 - Service certificate constraint</option>
                                        <option value="2">2 - Trust anchor assertion</option>
                                        <option value="3">3 - Domain-issued certificate</option>
                                      </select>
                                      <p className="mt-1 text-xs text-gray-500">Certificate usage</p>
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-smimea-selector" className="text-sm font-medium">Selector *</Label>
                                      <select
                                        id="edit-smimea-selector"
                                        value={editForm.smimeaSelector}
                                        onChange={(e) => handleEditFormChange("smimeaSelector", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="0">0 - Full certificate</option>
                                        <option value="1">1 - SubjectPublicKeyInfo</option>
                                      </select>
                                      <p className="mt-1 text-xs text-gray-500">What is matched</p>
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-smimea-matching-type" className="text-sm font-medium">Matching Type *</Label>
                                      <select
                                        id="edit-smimea-matching-type"
                                        value={editForm.smimeaMatchingType}
                                        onChange={(e) => handleEditFormChange("smimeaMatchingType", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="0">0 - No hash</option>
                                        <option value="1">1 - SHA-256</option>
                                        <option value="2">2 - SHA-512</option>
                                      </select>
                                      <p className="mt-1 text-xs text-gray-500">Hash algorithm</p>
                                    </div>
                                    <div className="md:col-span-4">
                                      <Label htmlFor="edit-smimea-certificate" className="text-sm font-medium">Certificate (Base64/Hex) *</Label>
                                      <Textarea
                                        id="edit-smimea-certificate"
                                        value={editForm.smimeaCertificate}
                                        onChange={(e) => handleEditFormChange("smimeaCertificate", e.target.value)}
                                        className="mt-1 font-mono text-xs"
                                        rows={6}
                                        placeholder="Base64 or hexadecimal encoded certificate data (A-Z, a-z, 0-9, +, /, =)"
                                        required
                                      />
                                      <p className="mt-1 text-xs text-gray-500">Only valid base64/hex characters allowed. Whitespace will be removed.</p>
                                    </div>
                                  </div>
                                )}

                                {/* SSHFP record structured fields for edit */}
                                {editForm.type === 'SSHFP' && (
                                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3 border-t pt-4">
                                    <div>
                                      <Label htmlFor="edit-sshfp-algorithm" className="text-sm font-medium">Algorithm *</Label>
                                      <select
                                        id="edit-sshfp-algorithm"
                                        value={editForm.sshfpAlgorithm}
                                        onChange={(e) => handleEditFormChange("sshfpAlgorithm", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="1">1 - RSA</option>
                                        <option value="2">2 - DSS</option>
                                        <option value="3">3 - ECDSA</option>
                                        <option value="4">4 - Ed25519</option>
                                      </select>
                                      <p className="mt-1 text-xs text-gray-500">SSH key algorithm</p>
                                    </div>
                                    <div>
                                      <Label htmlFor="edit-sshfp-fptype" className="text-sm font-medium">Fingerprint Type *</Label>
                                      <select
                                        id="edit-sshfp-fptype"
                                        value={editForm.sshfpFptype}
                                        onChange={(e) => handleEditFormChange("sshfpFptype", Number(e.target.value))}
                                        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                                        required
                                      >
                                        <option value="1">1 - SHA-1</option>
                                        <option value="2">2 - SHA-256</option>
                                      </select>
                                      <p className="mt-1 text-xs text-gray-500">Hash algorithm</p>
                                    </div>
                                    <div className="md:col-span-3">
                                      <Label htmlFor="edit-sshfp-fingerprint" className="text-sm font-medium">Fingerprint (Hex) *</Label>
                                      <Textarea
                                        id="edit-sshfp-fingerprint"
                                        value={editForm.sshfpFingerprint}
                                        onChange={(e) => handleEditFormChange("sshfpFingerprint", e.target.value)}
                                        className="mt-1 font-mono text-xs"
                                        rows={3}
                                        placeholder="Hexadecimal fingerprint (0-9, A-F)"
                                        required
                                      />
                                      <p className="mt-1 text-xs text-gray-500">Only valid hexadecimal characters allowed. Whitespace will be removed.</p>
                                    </div>
                                  </div>
                                )}

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
