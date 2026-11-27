export type Folder = 'inbox' | 'archive' | 'trash';

export interface Message {
  id: string;
  recipient: string;
  sender: string;
  subject: string;
  received: string;
  unread: boolean;
  starred: boolean;
  folder: string;
  labels: string[];
  state: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
}

export interface Detail extends Message {
  body: string;
  html: string;
  headers: Record<string, unknown>;
  error: string;
  attachments: Attachment[];
}

export interface DeliveryTest {
  delivery_test_address: string | null;
  delivery_test_expires: string | null;
  delivery_verified_at: string | null;
  test_expired: boolean | null;
}

export interface DeliveryHealth extends DeliveryTest {
  last_received: string | null;
  staging_error: boolean;
  activity: { id: string; recipient: string; time: string; status: string }[];
}

export interface Domain extends DeliveryTest {
  name: string;
  token: string;
  verified: boolean;
  last_received: string | null;
  retention_days: number | null;
  prune_days: number | null;
}

export interface CloudflareConnection {
  canProvision: boolean;
  oauthConnected: boolean;
  configured: boolean;
  fromEnvironment: boolean;
  workerConfigured: boolean;
  stagingConfigured: boolean;
}

export interface CloudflareStatus {
  detected: boolean;
  ready: boolean;
  message: string;
  applied?: boolean;
  dns: {
    nameservers: string[];
    mx: string[];
    txtVerified: boolean;
  };
}

export interface Address {
  address: string;
  name: string;
  pinned: boolean;
  unread: number;
  auto_label: string | null;
  webhook_id: string | null;
  removed_at: string | null;
}

export interface Integration {
  keys: { id: string; name: string; domain: string | null }[];
  hooks: { id: string; url: string; filter: string; address_only: boolean }[];
  deliveries: { id: string; url: string; status: string; result: string; attempted: string; replayable: boolean }[];
}

export interface Health {
  free: number;
  deferred: { status: string; count: number }[];
  staging: {
    configured: boolean;
    lastChecked: string | null;
    moreWaiting: boolean;
    error: boolean;
  };
  queues: { state: string; count: number; oldest: string }[];
  ingest: { id: string; recipient: string; status: string; time: string }[];
  deliveries: { status: string; count: number }[];
}

export interface OutboundProfile {
  id: string;
  workspace_id: string;
  domain: string;
  provider: 'smtp' | 'resend' | 'ses' | 'brevo' | 'mock';
  from_name: string;
  from_email: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface Suppression {
  id: string;
  email: string;
  domain: string | null;
  reason: 'bounce' | 'complaint' | 'manual';
  details: string;
  created_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  domain: string | null;
  created_at: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface DnsRecordItem {
  id?: string;
  type: 'TXT' | 'MX';
  name: string;
  expected: string;
  expectedPriority?: number;
  current?: string | null;
  currentPriority?: number;
  status: 'synced' | 'missing' | 'conflicted';
}

export interface DnsStatusReport {
  domain: string;
  zoneId: string;
  zoneName: string;
  detected: boolean;
  canSync: boolean;
  hasConflicts: boolean;
  conflicts: Array<{ id?: string; type: string; name: string; content: string; priority?: number }>;
  records: DnsRecordItem[];
  spf: { status: 'synced' | 'missing' | 'needs_merge'; current?: string | null; expected: string };
  dmarc: { status: 'synced' | 'missing'; current?: string | null; expected: string };
}

export interface SyncDnsReport {
  ok: boolean;
  domain: string;
  zoneId: string;
  verified: boolean;
  synced: Array<{ record: string; type: 'TXT' | 'MX'; action: 'created' | 'updated' | 'already_synced'; content: string; priority?: number }>;
  removed: Array<{ type: string; name: string; content: string; priority?: number }>;
  message: string;
}

export interface TailscaleHostInfo {
  installed: boolean;
  running: boolean;
  backendState: string;
  ips: string[];
  ipv4: string | null;
  ipv6: string | null;
  hostname: string | null;
  magicDns: string | null;
}

export interface TailscaleSettings {
  enabled: boolean;
  configuredOrigin: string | null;
  mode: 'serve' | 'direct' | 'sidecar' | 'custom';
}

export interface TailscaleStatusResponse {
  enabled: boolean;
  detected: boolean;
  host: TailscaleHostInfo;
  settings: TailscaleSettings;
  listenPort: number;
  bindAddress: string;
  activeOrigins: string[];
  suggestedOrigins: string[];
  serveCommand: string;
}

export interface TailscaleVerifyOriginResponse {
  origin: string;
  allowed: boolean;
  reason: string;
}

export interface ConnectedMailbox {
  id: string;
  workspace_id: string;
  provider: 'google' | 'microsoft';
  email: string;
  display_name: string | null;
  status: 'active' | 'paused' | 'revoked' | 'error';
  last_error: string | null;
  last_synced_at: string | null;
  direction: 'inbound_only';
  granted_scopes: string[];
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface OAuthProviderStatus {
  configured: boolean;
  fromEnv: boolean;
  clientId: string;
}

export interface OAuthProvidersResponse {
  google: OAuthProviderStatus;
  microsoft: OAuthProviderStatus;
}
