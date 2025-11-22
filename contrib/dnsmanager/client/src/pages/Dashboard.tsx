import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { apiRequest } from "../lib/api";
import { Star } from "lucide-react";
import { cn } from "../lib/utils";
import { TicketModal } from "../components/TicketModal";
import { toast, ToastContainer } from "../components/ui/toast";
import html2canvas from "html2canvas";

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


// Helper function to ensure a string ends with a dot
function ensureTrailingDot(value: string): string {
  if (!value) return value;
  return value.endsWith('.') ? value : `${value}.`;
}

// Helper function to generate a valid SOA serial number based on current date
function generateSerialNumber(): number {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return Number(`${year}${month}${day}01`); // Format: YYYYMMDD01
}

// Validate DNS hostname/domain (for Origin and NS fields)
function validateDnsName(value: string, fieldName: string): { valid: boolean; error?: string } {
  if (!value) {
    return { valid: false, error: `${fieldName} is required` };
  }

  // Remove trailing dot for validation
  const name = value.endsWith('.') ? value.slice(0, -1) : value;

  // Check for invalid characters
  if (!/^[a-zA-Z0-9.-]+$/.test(name)) {
    return { valid: false, error: `${fieldName} contains invalid characters. Use only letters, numbers, dots, and hyphens.` };
  }

  // Check for @ symbol (common mistake)
  if (value.includes('@')) {
    return { valid: false, error: `${fieldName} should not contain '@'. Use DNS format (e.g., admin.example.com.)` };
  }

  // Check each label
  const labels = name.split('.');
  for (const label of labels) {
    if (!label) {
      return { valid: false, error: `${fieldName} contains empty labels (consecutive dots)` };
    }
    if (label.length > 63) {
      return { valid: false, error: `${fieldName} has a label longer than 63 characters` };
    }
    if (label.startsWith('-') || label.endsWith('-')) {
      return { valid: false, error: `${fieldName} labels cannot start or end with hyphen` };
    }
  }

  return { valid: true };
}

// Validate Mbox field (should be in DNS format, not email format)
function validateMbox(value: string): { valid: boolean; error?: string } {
  if (!value) {
    return { valid: false, error: 'Mbox is required' };
  }

  // Check for @ symbol (common mistake - email format)
  if (value.includes('@')) {
    return {
      valid: false,
      error: 'Mbox should be in DNS format (e.g., admin.example.com.) not email format (admin@example.com). Replace @ with a dot.'
    };
  }

  // Use the same validation as DNS names
  return validateDnsName(value, 'Mbox');
}

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
function validateRrDomainName(value: string): { valid: boolean; error?: string } {
  if (!value) {
    return { valid: false, error: 'Domain name is required' };
  }

  // Remove trailing dot for validation
  const name = value.endsWith('.') ? value.slice(0, -1) : value;

  // Check for invalid characters
  if (!/^[a-zA-Z0-9.-]+$/.test(name)) {
    return { valid: false, error: 'Invalid domain name. Use only letters, numbers, dots, and hyphens.' };
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
    if (label.startsWith('-') || label.endsWith('-')) {
      return { valid: false, error: 'Domain name labels cannot start or end with hyphen' };
    }
  }

  return { valid: true };
}

// Validate RR content based on record type
function validateRrContent(type: string, value: string): { valid: boolean; error?: string } {
  // Block record types not commonly supported
  const unsupportedSimpleTypes = ['HINFO', 'RP'];
  if (unsupportedSimpleTypes.includes(type)) {
    return {
      valid: false,
      error: `${type} records are not supported in this interface. Use standard record types instead.`
    };
  }

  // Block complex structured record types that need special form fields
  const unsupportedTypes = ['CERT', 'DNSKEY', 'DS', 'SSHFP', 'TLSA', 'SMIMEA'];
  if (unsupportedTypes.includes(type)) {
    return {
      valid: false,
      error: `${type} records require structured data fields which are not supported in this interface. Use simple record types instead.`
    };
  }

  switch (type) {
    case 'A':
      return validateIPv4(value);
    case 'AAAA':
      return validateIPv6(value);
    case 'CNAME':
    case 'MX':
    case 'NS':
      return validateRrDomainName(value);
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

export function Dashboard({ onLogout, user }: { onLogout: () => void; user: any }) {
  const navigate = useNavigate();
  const [soaRecords, setSoaRecords] = useState<SoaRecord[]>([]);
  const [selectedSoa, setSelectedSoa] = useState<SoaRecord | null>(null);
  const [soaSearch, setSoaSearch] = useState("");
  const [editingSoaId, setEditingSoaId] = useState<number | null>(null);
  const [editSoaData, setEditSoaData] = useState<Partial<SoaRecord>>({});
  const [soaCurrentPage, setSoaCurrentPage] = useState(1);
  const soaRecordsPerPage = 10;
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
  const [showSoaAddForm, setShowSoaAddForm] = useState(false);
  const [showAddZoneModal, setShowAddZoneModal] = useState(false);
  const [newZoneAccountId, setNewZoneAccountId] = useState<number | null>(null);
  const [newZoneName, setNewZoneName] = useState("");
  const [newZoneJumpStart, setNewZoneJumpStart] = useState(false);
  const [ticketModalOpen, setTicketModalOpen] = useState(false);
  const [ticketScreenshot, setTicketScreenshot] = useState<string | null>(null);
  const [ticketPageUrl, setTicketPageUrl] = useState("");

  // Loading states for add buttons
  const [isAddingSoa, setIsAddingSoa] = useState(false);
  const [isAddingRr, setIsAddingRr] = useState(false);
  const [isAddingCfZone, setIsAddingCfZone] = useState(false);
  const [isAddingCfRecord, setIsAddingCfRecord] = useState(false);

  // Track selected RR type in add form for dynamic content field rendering
  const [rrAddType, setRrAddType] = useState("A");

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
    setSoaCurrentPage(1);
  }, [soaSearch]);

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

  const filteredSoaRecords = useMemo(() => {
    if (!soaSearch) return soaRecords;
    const lower = soaSearch.toLowerCase();
    return soaRecords.filter(
      (soa) =>
        soa.origin.toLowerCase().includes(lower) ||
        soa.ns.toLowerCase().includes(lower) ||
        soa.mbox.toLowerCase().includes(lower)
    );
  }, [soaRecords, soaSearch]);

  const paginatedSoaRecords = useMemo(() => {
    const startIndex = (soaCurrentPage - 1) * soaRecordsPerPage;
    const endIndex = startIndex + soaRecordsPerPage;
    return filteredSoaRecords.slice(startIndex, endIndex);
  }, [filteredSoaRecords, soaCurrentPage, soaRecordsPerPage]);

  const soaTotalPages = Math.ceil(filteredSoaRecords.length / soaRecordsPerPage);

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

  function startEditSoa(soa: SoaRecord) {
    setEditingSoaId(soa.id);
    setEditSoaData({
      ns: soa.ns,
      mbox: soa.mbox,
      serial: soa.serial,
      refresh: soa.refresh,
      retry: soa.retry,
      expire: soa.expire,
      minimum: soa.minimum,
      ttl: soa.ttl,
      active: soa.active,
    });
  }

  function cancelEditSoa() {
    setEditingSoaId(null);
    setEditSoaData({});
  }

  async function handleSoaUpdate() {
    if (!editingSoaId) return;

    // Validate NS field
    const nsValidation = validateDnsName(editSoaData.ns || "", "NS");
    if (!nsValidation.valid) {
      toast.error(nsValidation.error || "Invalid NS field");
      return;
    }

    // Validate Mbox field
    const mboxValidation = validateMbox(editSoaData.mbox || "");
    if (!mboxValidation.valid) {
      toast.error(mboxValidation.error || "Invalid Mbox field");
      return;
    }

    try {
      await apiRequest(`/soa/${editingSoaId}`, {
        method: "PUT",
        body: JSON.stringify({
          ns: ensureTrailingDot(editSoaData.ns || ""),
          mbox: ensureTrailingDot(editSoaData.mbox || ""),
          serial: Number(editSoaData.serial),
          refresh: Number(editSoaData.refresh),
          retry: Number(editSoaData.retry),
          expire: Number(editSoaData.expire),
          minimum: Number(editSoaData.minimum),
          ttl: Number(editSoaData.ttl),
          active: editSoaData.active,
        }),
      });
      setEditingSoaId(null);
      setEditSoaData({});
      toast.success("SOA record updated successfully");
      await refreshSoa();
    } catch (error: any) {
      console.error("Failed to update SOA:", error);
      toast.error(error.message || "Failed to update SOA record");
    }
  }

  async function handleSoaCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isAddingSoa) return; // Prevent duplicate submissions

    const form = event.currentTarget; // Store form reference before async operation
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    // Validate Origin field
    const originValidation = validateDnsName(payload.origin as string, "Origin");
    if (!originValidation.valid) {
      toast.error(originValidation.error || "Invalid Origin field");
      return;
    }

    // Validate NS field
    const nsValidation = validateDnsName(payload.ns as string, "NS");
    if (!nsValidation.valid) {
      toast.error(nsValidation.error || "Invalid NS field");
      return;
    }

    // Validate Mbox field
    const mboxValidation = validateMbox(payload.mbox as string);
    if (!mboxValidation.valid) {
      toast.error(mboxValidation.error || "Invalid Mbox field");
      return;
    }

    setIsAddingSoa(true);
    try {
      await apiRequest("/soa", {
        method: "POST",
        body: JSON.stringify({
          origin: ensureTrailingDot(payload.origin as string),
          ns: ensureTrailingDot(payload.ns as string),
          mbox: ensureTrailingDot(payload.mbox as string),
          serial: Number(payload.serial || generateSerialNumber()),
          refresh: Number(payload.refresh || 28800),
          retry: Number(payload.retry || 7200),
          expire: Number(payload.expire || 604800),
          minimum: Number(payload.minimum || 86400),
          ttl: Number(payload.ttl || 86400),
          active: (payload.active as string) || "Y",
        }),
      });
      setShowSoaAddForm(false);
      form.reset(); // Use stored reference instead of event.currentTarget
      toast.success("SOA record created successfully");
      await refreshSoa();
    } catch (error: any) {
      console.error("Failed to create SOA:", error);
      toast.error(error.message || "Failed to create SOA record");
    } finally {
      setIsAddingSoa(false);
    }
  }

  async function handleSoaDelete(soaId: number, origin: string) {
    if (!confirm(`Are you sure you want to delete the SOA record for "${origin}"?\n\nThis will also delete all associated RR records.`)) {
      return;
    }

    try {
      await apiRequest(`/soa/${soaId}`, {
        method: "DELETE",
      });
      toast.success("SOA record and associated RR records deleted successfully");
      await refreshSoa();
    } catch (error: any) {
      console.error("Failed to delete SOA:", error);
      toast.error(error.message || "Failed to delete SOA record");
    }
  }

  async function handleRrCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rrZoneId || isAddingRr) return; // Prevent duplicate submissions

    const form = event.currentTarget; // Store form reference before async operation
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    // Validate content based on record type
    const contentValidation = validateRrContent(payload.type as string, payload.data as string);
    if (!contentValidation.valid) {
      toast.error(contentValidation.error || "Invalid content for this record type");
      return;
    }

    setIsAddingRr(true);
    try {
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
      form.reset(); // Use stored reference instead of event.currentTarget
      setShowRrAddForm(false);
      setRrAddType("A"); // Reset to default type
      toast.success("RR record created successfully");
      refreshRr(rrZoneId);
    } catch (error: any) {
      console.error("Failed to create RR:", error);
      toast.error(error.message || "Failed to create RR record");
    } finally {
      setIsAddingRr(false);
    }
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
    try {
      await apiRequest(`/rr/${rrToDelete.id}`, { method: "DELETE" });
      setRrDeleteModalOpen(false);
      setRrToDelete(null);
      setRrDeleteConfirm("");
      await refreshRr(rrZoneId);
    } catch (error) {
      console.error("Failed to delete record:", error);
      alert("Failed to delete record");
    }
  }


  async function handleCreateZone() {
    if (!newZoneAccountId || !newZoneName || isAddingCfZone) return; // Prevent duplicate submissions

    if (!newZoneAccountId || !newZoneName) {
      toast.error("Please select an account and enter a zone name");
      return;
    }

    setIsAddingCfZone(true);
    try {
      const response = await apiRequest<{ success: boolean; name: string; name_servers?: string[] }>("/cloudflare/zones", {
        method: "POST",
        body: JSON.stringify({
          account_id: newZoneAccountId,
          zone_name: newZoneName,
          jump_start: newZoneJumpStart,
          zone_type: "full",
        }),
      });

      if (response.success) {
        toast.success(`Zone "${response.name}" created successfully!\n\nName servers:\n${response.name_servers?.join("\n") || "N/A"}`);
        setShowAddZoneModal(false);
        setNewZoneAccountId(null);
        setNewZoneName("");
        setNewZoneJumpStart(false);
        loadZones();
      }
    } catch (error: any) {
      console.error("Failed to create zone:", error);
      toast.error(error.message || "Failed to create zone");
    } finally {
      setIsAddingCfZone(false);
    }
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

  async function openSupportTicketModal() {
    setTicketPageUrl(window.location.href);

    // Capture screenshot of current page BEFORE opening modal
    try {
      const canvas = await html2canvas(document.body, {
        useCORS: true,
        scale: 1,
        scrollX: window.pageXOffset,
        scrollY: window.pageYOffset,
        logging: false,
      });

      const dataUrl = canvas.toDataURL("image/png");
      setTicketScreenshot(dataUrl);
    } catch (error) {
      console.error("Failed to capture screenshot:", error);
      setTicketScreenshot(null);
    }

    // Open modal after screenshot is captured
    setTicketModalOpen(true);
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">DNS Manager</h1>
          <p className="text-sm text-muted-foreground">Manage SOA/RR and mirrored Cloudflare data</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => navigate("/api-docs")}>
            API Docs
          </Button>
          <Button variant="outline" onClick={() => navigate("/my-settings")}>
            My Settings
          </Button>
          <Button variant="outline" onClick={openSupportTicketModal}>
            Support
          </Button>
          {user?.role === "superadmin" && (
            <>
              <Button variant="outline" onClick={() => navigate("/users")}>
                User Management
              </Button>
              <Button variant="outline" onClick={() => navigate("/zone-assignments")}>
                Zone Assignments
              </Button>
              <Button variant="outline" onClick={() => navigate("/settings")}>
                System Settings
              </Button>
            </>
          )}
          {(user?.role === "superadmin" || user?.role === "account_admin") && (
            <Button variant="outline" onClick={() => navigate("/permissions")}>
              Permissions
            </Button>
          )}
          <Button variant="outline" onClick={onLogout}>
            Logout
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <Tabs defaultValue="soa">
          <TabsList>
            <TabsTrigger value="soa">SOA Records</TabsTrigger>
            <TabsTrigger value="rr">Resource Records</TabsTrigger>
            <TabsTrigger value="cloudflare">Cloudflare Mirror</TabsTrigger>
          </TabsList>
          <TabsContent value="soa">
            <Card>
              <CardHeader>
                <CardTitle>SOA Records</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="w-64">
                    <Label htmlFor="soa-search" className="sr-only">Search</Label>
                    <Input
                      id="soa-search"
                      placeholder="Filter by origin, NS, or mbox"
                      value={soaSearch}
                      onChange={(e) => setSoaSearch(e.target.value)}
                    />
                  </div>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      setShowSoaAddForm(!showSoaAddForm);
                      setEditingSoaId(null);
                    }}
                  >
                    {showSoaAddForm ? "Close add panel" : "Add record"}
                  </Button>
                </div>

                {showSoaAddForm && (
                  <form className="space-y-4 rounded-md border bg-white p-6" onSubmit={handleSoaCreate}>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                      <div>
                        <Label htmlFor="soa-origin" className="text-sm font-medium">Origin *</Label>
                        <Input
                          id="soa-origin"
                          name="origin"
                          placeholder="example.com."
                          required
                        />
                      </div>
                      <div>
                        <Label htmlFor="soa-ns" className="text-sm font-medium">NS *</Label>
                        <Input
                          id="soa-ns"
                          name="ns"
                          placeholder="ns1.example.com."
                          required
                        />
                      </div>
                      <div>
                        <Label htmlFor="soa-mbox" className="text-sm font-medium">Mbox *</Label>
                        <Input
                          id="soa-mbox"
                          name="mbox"
                          placeholder="admin.example.com."
                          required
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
                      <div>
                        <Label htmlFor="soa-serial" className="text-sm font-medium">Serial</Label>
                        <Input
                          id="soa-serial"
                          name="serial"
                          type="number"
                          defaultValue={generateSerialNumber()}
                        />
                      </div>
                      <div>
                        <Label htmlFor="soa-refresh" className="text-sm font-medium">Refresh</Label>
                        <Input
                          id="soa-refresh"
                          name="refresh"
                          type="number"
                          defaultValue={28800}
                        />
                      </div>
                      <div>
                        <Label htmlFor="soa-retry" className="text-sm font-medium">Retry</Label>
                        <Input
                          id="soa-retry"
                          name="retry"
                          type="number"
                          defaultValue={7200}
                        />
                      </div>
                      <div>
                        <Label htmlFor="soa-expire" className="text-sm font-medium">Expire</Label>
                        <Input
                          id="soa-expire"
                          name="expire"
                          type="number"
                          defaultValue={604800}
                        />
                      </div>
                      <div>
                        <Label htmlFor="soa-minimum" className="text-sm font-medium">Minimum</Label>
                        <Input
                          id="soa-minimum"
                          name="minimum"
                          type="number"
                          defaultValue={86400}
                        />
                      </div>
                      <div>
                        <Label htmlFor="soa-ttl" className="text-sm font-medium">TTL</Label>
                        <Input
                          id="soa-ttl"
                          name="ttl"
                          type="number"
                          defaultValue={86400}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div>
                        <Label htmlFor="soa-active" className="text-sm font-medium">Active</Label>
                        <select
                          id="soa-active"
                          name="active"
                          className="ml-2 rounded-md border px-3 py-1 text-sm"
                          defaultValue="Y"
                        >
                          <option value="Y">Yes</option>
                          <option value="N">No</option>
                        </select>
                      </div>
                      <Button type="submit" className="ml-auto" disabled={isAddingSoa}>
                        {isAddingSoa ? "Creating..." : "Create SOA Record"}
                      </Button>
                    </div>
                  </form>
                )}

                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Origin</TableHead>
                        <TableHead>NS</TableHead>
                        <TableHead>Mbox</TableHead>
                        <TableHead>Serial</TableHead>
                        <TableHead>Refresh</TableHead>
                        <TableHead>Retry</TableHead>
                        <TableHead>Expire</TableHead>
                        <TableHead>Minimum</TableHead>
                        <TableHead>TTL</TableHead>
                        <TableHead>Active</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedSoaRecords.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={11} className="text-center text-sm text-muted-foreground">
                            No SOA records found
                          </TableCell>
                        </TableRow>
                      ) : (
                        paginatedSoaRecords.map((soa) => (
                          <Fragment key={soa.id}>
                            <TableRow
                              className={cn(
                                "hover:bg-muted/50",
                                editingSoaId === soa.id && "bg-blue-50"
                              )}
                            >
                              <TableCell className="font-medium">{soa.origin}</TableCell>
                              <TableCell className="text-sm">{soa.ns}</TableCell>
                              <TableCell className="text-sm">{soa.mbox}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{soa.serial}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{soa.refresh}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{soa.retry}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{soa.expire}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{soa.minimum}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{soa.ttl}</TableCell>
                              <TableCell>
                                <span className={cn(
                                  "inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold",
                                  soa.active === "Y" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"
                                )}>
                                  {soa.active === "Y" ? "Active" : "Inactive"}
                                </span>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => editingSoaId === soa.id ? cancelEditSoa() : startEditSoa(soa)}
                                    className={editingSoaId === soa.id ? "text-gray-600 hover:text-gray-700" : "text-blue-600 hover:text-blue-700"}
                                  >
                                    {editingSoaId === soa.id ? "Cancel" : "Edit"}
                                  </Button>
                                  {editingSoaId !== soa.id && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleSoaDelete(soa.id, soa.origin)}
                                      className="text-red-600 hover:text-red-700"
                                    >
                                      Delete
                                    </Button>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>

                            {/* Edit Panel - appears below the row being edited */}
                            {editingSoaId === soa.id && (
                              <TableRow>
                                <TableCell colSpan={11} className="bg-blue-50/50 p-0">
                                  <div className="space-y-4 p-6">
                                    <div className="flex items-center justify-between border-b pb-2">
                                      <h3 className="text-sm font-semibold text-gray-900">
                                        Editing SOA Record: {soa.origin}
                                      </h3>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={cancelEditSoa}
                                        className="text-gray-600"
                                      >
                                        ✕
                                      </Button>
                                    </div>

                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                      <div>
                                        <Label htmlFor="edit-soa-origin" className="text-sm font-medium">
                                          Origin (read-only)
                                        </Label>
                                        <Input
                                          id="edit-soa-origin"
                                          value={soa.origin}
                                          disabled
                                          className="bg-gray-100"
                                        />
                                      </div>
                                      <div>
                                        <Label htmlFor="edit-soa-ns" className="text-sm font-medium">
                                          NS *
                                        </Label>
                                        <Input
                                          id="edit-soa-ns"
                                          value={editSoaData.ns || ""}
                                          onChange={(e) => setEditSoaData({ ...editSoaData, ns: e.target.value })}
                                          placeholder="ns1.example.com."
                                        />
                                      </div>
                                      <div>
                                        <Label htmlFor="edit-soa-mbox" className="text-sm font-medium">
                                          Mbox *
                                        </Label>
                                        <Input
                                          id="edit-soa-mbox"
                                          value={editSoaData.mbox || ""}
                                          onChange={(e) => setEditSoaData({ ...editSoaData, mbox: e.target.value })}
                                          placeholder="admin.example.com."
                                        />
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
                                      <div>
                                        <Label htmlFor="edit-soa-serial" className="text-sm font-medium">
                                          Serial
                                        </Label>
                                        <Input
                                          id="edit-soa-serial"
                                          type="number"
                                          value={editSoaData.serial ?? 0}
                                          onChange={(e) => setEditSoaData({ ...editSoaData, serial: Number(e.target.value) })}
                                        />
                                      </div>
                                      <div>
                                        <Label htmlFor="edit-soa-refresh" className="text-sm font-medium">
                                          Refresh
                                        </Label>
                                        <Input
                                          id="edit-soa-refresh"
                                          type="number"
                                          value={editSoaData.refresh ?? 0}
                                          onChange={(e) => setEditSoaData({ ...editSoaData, refresh: Number(e.target.value) })}
                                        />
                                      </div>
                                      <div>
                                        <Label htmlFor="edit-soa-retry" className="text-sm font-medium">
                                          Retry
                                        </Label>
                                        <Input
                                          id="edit-soa-retry"
                                          type="number"
                                          value={editSoaData.retry ?? 0}
                                          onChange={(e) => setEditSoaData({ ...editSoaData, retry: Number(e.target.value) })}
                                        />
                                      </div>
                                      <div>
                                        <Label htmlFor="edit-soa-expire" className="text-sm font-medium">
                                          Expire
                                        </Label>
                                        <Input
                                          id="edit-soa-expire"
                                          type="number"
                                          value={editSoaData.expire ?? 0}
                                          onChange={(e) => setEditSoaData({ ...editSoaData, expire: Number(e.target.value) })}
                                        />
                                      </div>
                                      <div>
                                        <Label htmlFor="edit-soa-minimum" className="text-sm font-medium">
                                          Minimum
                                        </Label>
                                        <Input
                                          id="edit-soa-minimum"
                                          type="number"
                                          value={editSoaData.minimum ?? 0}
                                          onChange={(e) => setEditSoaData({ ...editSoaData, minimum: Number(e.target.value) })}
                                        />
                                      </div>
                                      <div>
                                        <Label htmlFor="edit-soa-ttl" className="text-sm font-medium">
                                          TTL
                                        </Label>
                                        <Input
                                          id="edit-soa-ttl"
                                          type="number"
                                          value={editSoaData.ttl ?? 0}
                                          onChange={(e) => setEditSoaData({ ...editSoaData, ttl: Number(e.target.value) })}
                                        />
                                      </div>
                                    </div>

                                    <div className="flex items-center justify-between">
                                      <div>
                                        <Label htmlFor="edit-soa-active" className="text-sm font-medium">
                                          Active
                                        </Label>
                                        <select
                                          id="edit-soa-active"
                                          value={editSoaData.active || "Y"}
                                          onChange={(e) => setEditSoaData({ ...editSoaData, active: e.target.value as "Y" | "N" })}
                                          className="ml-2 rounded-md border px-3 py-2 text-sm"
                                        >
                                          <option value="Y">Yes</option>
                                          <option value="N">No</option>
                                        </select>
                                      </div>
                                      <div className="flex gap-2">
                                        <Button
                                          variant="outline"
                                          onClick={cancelEditSoa}
                                        >
                                          Cancel
                                        </Button>
                                        <Button
                                          onClick={handleSoaUpdate}
                                          className="bg-blue-600 hover:bg-blue-700"
                                        >
                                          Save Changes
                                        </Button>
                                      </div>
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>

                {filteredSoaRecords.length > 0 && (
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      Showing {((soaCurrentPage - 1) * soaRecordsPerPage) + 1} to {Math.min(soaCurrentPage * soaRecordsPerPage, filteredSoaRecords.length)} of {filteredSoaRecords.length} records
                      {soaSearch && ` (filtered from ${soaRecords.length} total)`}
                    </p>
                    {soaTotalPages > 1 && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSoaCurrentPage(1)}
                          disabled={soaCurrentPage === 1}
                        >
                          First
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSoaCurrentPage(soaCurrentPage - 1)}
                          disabled={soaCurrentPage === 1}
                        >
                          Previous
                        </Button>
                        <span className="text-sm text-muted-foreground">
                          Page {soaCurrentPage} of {soaTotalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSoaCurrentPage(soaCurrentPage + 1)}
                          disabled={soaCurrentPage === soaTotalPages}
                        >
                          Next
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSoaCurrentPage(soaTotalPages)}
                          disabled={soaCurrentPage === soaTotalPages}
                        >
                          Last
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
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
                    onClick={() => {
                      setShowRrAddForm(!showRrAddForm);
                      if (!showRrAddForm) {
                        setRrAddType("A"); // Reset to default type when opening form
                      }
                    }}
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
                          value={rrAddType}
                          onChange={(e) => setRrAddType(e.target.value)}
                          className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                          required
                        >
                          {["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "PTR", "NAPTR"].map((type) => (
                            <option key={type}>{type}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="rr-name" className="text-sm font-medium">Name</Label>
                        <Input id="rr-name" name="name" className="mt-1" required />
                      </div>
                      <div className="md:col-span-2">
                        <Label htmlFor="rr-data" className="text-sm font-medium">
                          Content
                          {rrAddType === 'A' && ' (IPv4 address)'}
                          {rrAddType === 'AAAA' && ' (IPv6 address)'}
                          {(rrAddType === 'CNAME' || rrAddType === 'MX' || rrAddType === 'NS') && ' (Domain name)'}
                        </Label>
                        {rrAddType === 'TXT' ? (
                          <Textarea id="rr-data" name="data" className="mt-1" rows={3} required />
                        ) : (
                          <Input
                            id="rr-data"
                            name="data"
                            className="mt-1"
                            required
                            placeholder={
                              rrAddType === 'A' ? 'e.g., 192.168.1.1' :
                              rrAddType === 'AAAA' ? 'e.g., 2001:db8::1' :
                              (rrAddType === 'CNAME' || rrAddType === 'MX' || rrAddType === 'NS') ? 'e.g., example.com.' :
                              ''
                            }
                          />
                        )}
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
                        <Button type="submit" className="w-full" disabled={isAddingRr}>
                          {isAddingRr ? "Adding..." : "Add record"}
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
                                    {["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "PTR", "NAPTR"].map((type) => (
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
                    <div className="flex items-end gap-2">
                      <Button variant="ghost" onClick={() => { setAccountSearch(""); setZoneSearch(""); }}>
                        Clear filters
                      </Button>
                      <Button variant="default" onClick={() => setShowAddZoneModal(true)}>
                        Add Zone
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Add Zone Modal */}
              {showAddZoneModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                  <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
                    <h2 className="mb-4 text-lg font-semibold">Add New Zone</h2>
                    <div className="space-y-4">
                      <div>
                        <Label htmlFor="new-zone-account">Account *</Label>
                        <select
                          id="new-zone-account"
                          className="mt-1 w-full rounded-md border px-3 py-2"
                          value={newZoneAccountId || ""}
                          onChange={(e) => setNewZoneAccountId(Number(e.target.value))}
                        >
                          <option value="">Select account</option>
                          {cfAccounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor="new-zone-name">Zone Name (Domain) *</Label>
                        <Input
                          id="new-zone-name"
                          placeholder="example.com"
                          value={newZoneName}
                          onChange={(e) => setNewZoneName(e.target.value)}
                          className="mt-1"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="new-zone-jumpstart"
                          checked={newZoneJumpStart}
                          onChange={(e) => setNewZoneJumpStart(e.target.checked)}
                          className="rounded"
                        />
                        <Label htmlFor="new-zone-jumpstart" className="cursor-pointer">
                          Scan for existing DNS records
                        </Label>
                      </div>
                      <div className="flex justify-end gap-2 pt-4">
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setShowAddZoneModal(false);
                            setNewZoneAccountId(null);
                            setNewZoneName("");
                            setNewZoneJumpStart(false);
                          }}
                        >
                          Cancel
                        </Button>
                        <Button onClick={handleCreateZone} disabled={isAddingCfZone}>
                          {isAddingCfZone ? "Creating..." : "Create Zone"}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

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

      <TicketModal
        isOpen={ticketModalOpen}
        onClose={() => setTicketModalOpen(false)}
        screenshotData={ticketScreenshot}
        pageUrl={ticketPageUrl}
      />
      <ToastContainer />
    </div>
  );
}
