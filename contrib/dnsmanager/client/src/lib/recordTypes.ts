// DNS Record Type configurations matching Cloudflare's UI

export interface RecordTypeConfig {
  value: string;
  label: string;
  contentLabel: string;
  contentPlaceholder?: string;
  supportsProxy?: boolean;
  supportsPriority?: boolean;
  supportsWeight?: boolean;
  supportsPort?: boolean;
  supportsTarget?: boolean;
  fields?: string[];
}

export const RECORD_TYPES: Record<string, RecordTypeConfig> = {
  A: {
    value: "A",
    label: "A",
    contentLabel: "IPv4 address",
    contentPlaceholder: "198.51.100.1",
    supportsProxy: true,
  },
  AAAA: {
    value: "AAAA",
    label: "AAAA",
    contentLabel: "IPv6 address",
    contentPlaceholder: "2001:0db8:85a3::8a2e:0370:7334",
    supportsProxy: true,
  },
  CNAME: {
    value: "CNAME",
    label: "CNAME",
    contentLabel: "Target",
    contentPlaceholder: "example.com",
    supportsProxy: true,
  },
  MX: {
    value: "MX",
    label: "MX",
    contentLabel: "Mail server",
    contentPlaceholder: "mail.example.com",
    supportsPriority: true,
  },
  TXT: {
    value: "TXT",
    label: "TXT",
    contentLabel: "Content",
    contentPlaceholder: "Enter text content",
  },
  NS: {
    value: "NS",
    label: "NS",
    contentLabel: "Nameserver",
    contentPlaceholder: "ns1.example.com",
  },
  SRV: {
    value: "SRV",
    label: "SRV",
    contentLabel: "Target",
    contentPlaceholder: "target.example.com",
    supportsPriority: true,
    supportsWeight: true,
    supportsPort: true,
    supportsTarget: true,
  },
  PTR: {
    value: "PTR",
    label: "PTR",
    contentLabel: "Target",
    contentPlaceholder: "example.com",
  },
  CAA: {
    value: "CAA",
    label: "CAA",
    contentLabel: "Value",
    contentPlaceholder: "ca.example.com",
  },
  CERT: {
    value: "CERT",
    label: "CERT",
    contentLabel: "Certificate",
  },
  DNSKEY: {
    value: "DNSKEY",
    label: "DNSKEY",
    contentLabel: "Key",
  },
  DS: {
    value: "DS",
    label: "DS",
    contentLabel: "Digest",
  },
  HTTPS: {
    value: "HTTPS",
    label: "HTTPS",
    contentLabel: "Value",
  },
  LOC: {
    value: "LOC",
    label: "LOC",
    contentLabel: "Location",
  },
  NAPTR: {
    value: "NAPTR",
    label: "NAPTR",
    contentLabel: "Value",
    supportsPriority: true,
  },
  OPENPGPKEY: {
    value: "OPENPGPKEY",
    label: "OPENPGPKEY",
    contentLabel: "Public key",
  },
  SMIMEA: {
    value: "SMIMEA",
    label: "SMIMEA",
    contentLabel: "Certificate",
  },
  SSHFP: {
    value: "SSHFP",
    label: "SSHFP",
    contentLabel: "Fingerprint",
  },
  SVCB: {
    value: "SVCB",
    label: "SVCB",
    contentLabel: "Value",
    supportsPriority: true,
  },
  TLSA: {
    value: "TLSA",
    label: "TLSA",
    contentLabel: "Certificate",
  },
  URI: {
    value: "URI",
    label: "URI",
    contentLabel: "URI",
    supportsPriority: true,
  },
  RP: {
    value: "RP",
    label: "RP",
    contentLabel: "Mailbox",
  },
  HINFO: {
    value: "HINFO",
    label: "HINFO",
    contentLabel: "Hardware/OS",
  },
};

export const RECORD_TYPE_LIST = Object.values(RECORD_TYPES).sort((a, b) =>
  a.label.localeCompare(b.label)
);

export const TTL_OPTIONS = [
  { value: 1, label: "Auto" },
  { value: 60, label: "1 min" },
  { value: 120, label: "2 min" },
  { value: 300, label: "5 min" },
  { value: 600, label: "10 min" },
  { value: 900, label: "15 min" },
  { value: 1800, label: "30 min" },
  { value: 3600, label: "1 hr" },
  { value: 7200, label: "2 hr" },
  { value: 18000, label: "5 hr" },
  { value: 43200, label: "12 hr" },
  { value: 86400, label: "1 day" },
];

export function getTTLLabel(ttl: number | null | undefined): string {
  if (ttl === null || ttl === undefined) return "Auto";
  if (ttl === 1) return "Auto";
  const option = TTL_OPTIONS.find((opt) => opt.value === ttl);
  if (option) return option.label;
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)} min`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)} hr`;
  return `${Math.floor(ttl / 86400)} day${ttl >= 172800 ? "s" : ""}`;
}
