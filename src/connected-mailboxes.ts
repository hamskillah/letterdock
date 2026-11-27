import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { encryptSecret, decryptSecret, sha256 } from './crypto.js';
import { storage } from './storage.js';
import { simpleParser } from 'mailparser';

export type OAuthProvider = 'google' | 'microsoft';

export interface ConnectedMailbox {
  id: string;
  workspace_id: string;
  provider: OAuthProvider;
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

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  configured: boolean;
  fromEnv: boolean;
}

// In-flight refresh token promises to prevent concurrent refresh races
const refreshLocks = new Map<string, Promise<string>>();

/**
 * Get OAuth Client configuration for a provider.
 * Resolves from Environment Variables first, falls back to encrypted database settings.
 */
export async function getOAuthProviderConfig(provider: OAuthProvider): Promise<OAuthProviderConfig> {
  const envPrefix = provider.toUpperCase();
  const envClientId = process.env[`${envPrefix}_OAUTH_CLIENT_ID`];
  const envClientSecret = process.env[`${envPrefix}_OAUTH_CLIENT_SECRET`];

  if (envClientId && envClientSecret) {
    return {
      clientId: envClientId.trim(),
      clientSecret: envClientSecret.trim(),
      configured: true,
      fromEnv: true
    };
  }

  // Fallback to database settings
  const settingKey = `oauth_provider_${provider}`;
  const { rows: [row] } = await db.query('SELECT value FROM settings WHERE key=$1', [settingKey]);
  if (row) {
    try {
      const decrypted = decryptSecret(row.value, 'oauth-config');
      const parsed = JSON.parse(decrypted);
      if (parsed.clientId && parsed.clientSecret) {
        return {
          clientId: parsed.clientId,
          clientSecret: parsed.clientSecret,
          configured: true,
          fromEnv: false
        };
      }
    } catch {}
  }

  return {
    clientId: '',
    clientSecret: '',
    configured: false,
    fromEnv: false
  };
}

/**
 * Save OAuth Client configuration for a provider into encrypted settings.
 */
export async function saveOAuthProviderConfig(provider: OAuthProvider, clientId: string, clientSecret: string): Promise<void> {
  const settingKey = `oauth_provider_${provider}`;
  const payload = JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
  const encrypted = encryptSecret(payload, 'oauth-config');
  await db.query(`
    INSERT INTO settings(key, value) VALUES($1, $2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [settingKey, encrypted]);
}

/**
 * Initiate OAuth 2.0 Authorization Code flow with PKCE (RFC 7636).
 */
export async function startMailboxOAuth(options: {
  provider: OAuthProvider;
  redirectUri: string;
  workspaceId?: string;
  origin?: string;
}): Promise<{ url: string; state: string }> {
  const { provider, redirectUri, workspaceId = 'default', origin } = options;
  const config = await getOAuthProviderConfig(provider);
  if (!config.configured) {
    throw new Error(`OAuth provider ${provider} is not configured. Set client credentials first.`);
  }

  // 1. Generate PKCE code_verifier and code_challenge (S256)
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  // 2. Generate random state and OIDC nonce
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');

  // 3. Persist state in database with 10-minute expiration
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.query(`
    INSERT INTO oauth_states(state, provider, code_verifier, nonce, redirect_uri, workspace_id, origin, expires_at)
    VALUES($1, $2, $3, $4, $5, $6, $7, $8)
  `, [state, provider, codeVerifier, nonce, redirectUri, workspaceId, origin || null, expiresAt]);

  // Clean up expired states
  await db.query('DELETE FROM oauth_states WHERE expires_at < now()').catch(() => {});

  // 4. Construct Authorization URL with strictly READ-ONLY scopes
  let authUrl: URL;
  if (provider === 'google') {
    authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // Strictly read-only Gmail access + profile identity
      scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline', // Mandatory to receive refresh_token
      prompt: 'consent',     // Guarantees refresh_token on repeated auth
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      nonce
    }).toString();
  } else {
    // Microsoft identity (Supports personal Hotmail/Outlook and organizational M365)
    authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    authUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      // Strictly read-only Mail.Read + identity + offline_access
      scope: 'openid email profile offline_access Mail.Read',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      nonce
    }).toString();
  }

  return { url: authUrl.href, state };
}

/**
 * Complete OAuth 2.0 Authorization Code exchange with PKCE and verify granted scopes.
 */
export async function completeMailboxOAuth(options: {
  provider: OAuthProvider;
  code: string;
  state: string;
}): Promise<ConnectedMailbox> {
  const { provider, code, state } = options;

  // 1. Atomically consume single-use state from DB
  const { rows: [oauthState] } = await db.query(`
    DELETE FROM oauth_states 
    WHERE state = $1 AND provider = $2 AND expires_at > now()
    RETURNING *
  `, [state, provider]);

  if (!oauthState) {
    throw new Error('Invalid or expired OAuth state parameter. Please restart authorization.');
  }

  const config = await getOAuthProviderConfig(provider);
  if (!config.configured) {
    throw new Error(`OAuth provider ${provider} configuration missing.`);
  }

  // 2. Exchange authorization code for tokens
  let tokenEndpoint = '';
  let tokenParams: Record<string, string> = {};

  if (provider === 'google') {
    tokenEndpoint = 'https://oauth2.googleapis.com/token';
    tokenParams = {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: oauthState.code_verifier,
      grant_type: 'authorization_code',
      redirect_uri: oauthState.redirect_uri
    };
  } else {
    tokenEndpoint = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    tokenParams = {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: oauthState.code_verifier,
      grant_type: 'authorization_code',
      redirect_uri: oauthState.redirect_uri
    };
  }

  const tokenRes = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(tokenParams).toString(),
    signal: AbortSignal.timeout(15000)
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => '');
    throw new Error(`Failed to exchange authorization code (${tokenRes.status}): ${errBody}`);
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    id_token?: string;
  };

  if (!tokenData.access_token) {
    throw new Error('OAuth token endpoint response did not include access_token.');
  }

  // 3. Strict Scope Verification Gate (Defense-in-Depth against Send Permissions)
  const rawScopes = typeof tokenData.scope === 'string'
    ? tokenData.scope.split(/\s+/).map(s => s.trim().toLowerCase())
    : [];

  // Strip Microsoft Graph prefix if present for robust scope matching
  const grantedScopes = rawScopes.map(s => s.replace(/^https:\/\/graph\.microsoft\.com\//i, ''));

  // Prohibited send / modification scope patterns
  const prohibitedPatterns = [
    'gmail.send',
    'gmail.compose',
    'gmail.modify',
    'mail.google.com',
    'mail.send',
    'mail.readwrite'
  ];

  for (const scope of grantedScopes) {
    if (prohibitedPatterns.some(p => scope.includes(p))) {
      throw new Error(`Security violation: Token contains unauthorized write/send permission: ${scope}. Connection rejected.`);
    }
  }

  // Required read-only permission check
  const hasReadPermission = provider === 'google'
    ? grantedScopes.some(s => s.includes('gmail.readonly'))
    : grantedScopes.some(s => s === 'mail.read' || s.endsWith('/mail.read'));

  if (!hasReadPermission) {
    throw new Error(`Token lacks required read-only mailbox scope for ${provider}.`);
  }

  // 4. Retrieve User Profile & Email Identity
  let userEmail = '';
  let displayName: string | null = null;

  if (provider === 'google') {
    const userinfoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!userinfoRes.ok) {
      throw new Error('Failed to retrieve user profile from Google UserInfo endpoint.');
    }
    const profile = await userinfoRes.json() as { email?: string; name?: string };
    userEmail = profile.email || '';
    displayName = profile.name || null;
  } else {
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!meRes.ok) {
      throw new Error('Failed to retrieve user profile from Microsoft Graph endpoint.');
    }
    const me = await meRes.json() as { mail?: string; userPrincipalName?: string; displayName?: string };
    userEmail = (me.mail || me.userPrincipalName || '').toLowerCase();
    displayName = me.displayName || null;
  }

  if (!userEmail || !userEmail.includes('@')) {
    throw new Error('Could not resolve valid email address from provider profile.');
  }

  // 5. Encrypt Tokens via AES-256-GCM using APP_ENCRYPTION_KEY
  const encryptedAccess = encryptSecret(tokenData.access_token, 'oauth-token');
  const tokenExpiresAt = new Date(Date.now() + Math.max(60, (Number(tokenData.expires_in) || 3600) - 120) * 1000);

  // If refresh_token is present in response, encrypt it; otherwise retain existing if updating
  let encryptedRefresh = '';
  if (tokenData.refresh_token) {
    encryptedRefresh = encryptSecret(tokenData.refresh_token, 'oauth-token');
  } else {
    // Check if mailbox previously existed to preserve refresh token
    const { rows: [existing] } = await db.query(
      'SELECT encrypted_refresh_token FROM connected_mailboxes WHERE workspace_id = $1 AND provider = $2 AND email = $3',
      [oauthState.workspace_id, provider, userEmail]
    );
    if (existing?.encrypted_refresh_token) {
      encryptedRefresh = existing.encrypted_refresh_token;
    } else {
      throw new Error('Provider did not return a refresh token, and no existing token was found. Reconnect required.');
    }
  }

  // 6. Ensure sender domain is recorded in domains table to satisfy relational integrity (unverified for outbound relay)
  const domainPart = userEmail.slice(userEmail.lastIndexOf('@') + 1).toLowerCase();
  await db.query(`
    INSERT INTO domains(name, verified, retention_days)
    VALUES($1, false, 30)
    ON CONFLICT (name) DO NOTHING
  `, [domainPart]);

  // 7. Upsert into connected_mailboxes with strict direction = 'inbound_only'
  const { rows: [saved] } = await db.query(`
    INSERT INTO connected_mailboxes(
      workspace_id, provider, email, display_name,
      encrypted_access_token, encrypted_refresh_token, token_expires_at,
      granted_scopes, status, direction, updated_at
    )
    VALUES($1, $2, $3, $4, $5, $6, $7, $8, 'active', 'inbound_only', now())
    ON CONFLICT (workspace_id, provider, email) DO UPDATE SET
      display_name = excluded.display_name,
      encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = excluded.encrypted_refresh_token,
      token_expires_at = excluded.token_expires_at,
      granted_scopes = excluded.granted_scopes,
      status = 'active',
      last_error = NULL,
      updated_at = now()
    RETURNING id, workspace_id, provider, email, display_name, status, last_error,
              last_synced_at, direction, granted_scopes, created_at, updated_at
  `, [
    oauthState.workspace_id, provider, userEmail.toLowerCase(), displayName,
    encryptedAccess, encryptedRefresh, tokenExpiresAt, grantedScopes
  ]);

  return saved;
}

/**
 * Acquire a valid access token for a connected mailbox, refreshing it automatically if expired.
 * Employs mutex deduplication to prevent concurrent refresh races.
 */
export async function getValidAccessToken(mailboxId: string): Promise<string> {
  const { rows: [mb] } = await db.query(`
    SELECT id, workspace_id, provider, email, encrypted_access_token,
           encrypted_refresh_token, token_expires_at, status
    FROM connected_mailboxes WHERE id = $1
  `, [mailboxId]);

  if (!mb) {
    throw new Error(`Connected mailbox ${mailboxId} not found.`);
  }

  if (mb.status === 'revoked') {
    throw new Error(`Mailbox authorization for ${mb.email} has been revoked by user or provider.`);
  }

  // If token is still valid for at least 3 minutes, return decrypted token directly
  const now = Date.now();
  const expiresMs = new Date(mb.token_expires_at).getTime();
  if (expiresMs > now + 3 * 60 * 1000) {
    return decryptSecret(mb.encrypted_access_token, 'oauth-token');
  }

  // Mutex lock for token refresh per mailbox
  if (refreshLocks.has(mailboxId)) {
    return await refreshLocks.get(mailboxId)!;
  }

  const refreshPromise = (async () => {
    try {
      const config = await getOAuthProviderConfig(mb.provider);
      if (!config.configured) {
        throw new Error(`OAuth provider ${mb.provider} is not configured.`);
      }

      const refreshToken = decryptSecret(mb.encrypted_refresh_token, 'oauth-token');
      const tokenEndpoint = mb.provider === 'google'
        ? 'https://oauth2.googleapis.com/token'
        : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

      const res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }).toString(),
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        if (res.status === 400 && errorText.includes('invalid_grant')) {
          // Token permanently revoked
          await db.query(`
            UPDATE connected_mailboxes 
            SET status = 'revoked', last_error = 'Authorization revoked by provider or user.', updated_at = now()
            WHERE id = $1
          `, [mailboxId]);
          throw new Error(`Access revoked for ${mb.email}. Please reconnect the account.`);
        }
        throw new Error(`Token refresh failed (${res.status}): ${errorText}`);
      }

      const refreshed = await res.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      const newEncryptedAccess = encryptSecret(refreshed.access_token, 'oauth-token');
      const newExpiresAt = new Date(Date.now() + Math.max(60, (Number(refreshed.expires_in) || 3600) - 120) * 1000);

      if (refreshed.refresh_token) {
        // Refresh token rotation occurred
        const newEncryptedRefresh = encryptSecret(refreshed.refresh_token, 'oauth-token');
        await db.query(`
          UPDATE connected_mailboxes
          SET encrypted_access_token = $1, encrypted_refresh_token = $2,
              token_expires_at = $3, status = 'active', last_error = NULL, updated_at = now()
          WHERE id = $4
        `, [newEncryptedAccess, newEncryptedRefresh, newExpiresAt, mailboxId]);
      } else {
        await db.query(`
          UPDATE connected_mailboxes
          SET encrypted_access_token = $1, token_expires_at = $2,
              status = 'active', last_error = NULL, updated_at = now()
          WHERE id = $3
        `, [newEncryptedAccess, newExpiresAt, mailboxId]);
      }

      return refreshed.access_token;
    } finally {
      refreshLocks.delete(mailboxId);
    }
  })();

  refreshLocks.set(mailboxId, refreshPromise);
  return await refreshPromise;
}

/**
 * List all connected mailboxes for a workspace with message counts.
 */
export async function listConnectedMailboxes(workspaceId = 'default'): Promise<ConnectedMailbox[]> {
  const { rows } = await db.query(`
    SELECT 
      m.id, m.workspace_id, m.provider, m.email, m.display_name,
      m.status, m.last_error, m.last_synced_at, m.direction,
      m.granted_scopes, m.created_at, m.updated_at,
      COUNT(msg.id)::int AS message_count
    FROM connected_mailboxes m
    LEFT JOIN messages msg ON msg.mailbox_id = m.id
    WHERE m.workspace_id = $1
    GROUP BY m.id
    ORDER BY m.created_at DESC
  `, [workspaceId]);

  return rows;
}

/**
 * Disconnect a connected mailbox, optionally deleting all downloaded local emails.
 */
export async function disconnectConnectedMailbox(mailboxId: string, deleteLocalData = false): Promise<void> {
  const { rows: [mb] } = await db.query(
    'SELECT id, provider, encrypted_refresh_token FROM connected_mailboxes WHERE id = $1',
    [mailboxId]
  );
  if (!mb) return;

  // Best-effort token revocation at provider
  try {
    const refreshToken = decryptSecret(mb.encrypted_refresh_token, 'oauth-token');
    if (mb.provider === 'google') {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refreshToken), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(5000)
      }).catch(() => {});
    }
  } catch {}

  if (deleteLocalData) {
    // 1. Delete attachment binary blobs in storage
    const { rows: atts } = await db.query(
      'SELECT a.storage_key FROM attachments a JOIN messages m ON m.id = a.message WHERE m.mailbox_id = $1 AND a.storage_key IS NOT NULL',
      [mailboxId]
    );
    for (const att of atts) {
      if (att.storage_key) {
        await storage.delete(att.storage_key).catch(() => {});
      }
    }

    // 2. Delete raw blob payloads associated with this mailbox
    const { rows: msgs } = await db.query(
      'SELECT raw_storage_key FROM messages WHERE mailbox_id = $1 AND raw_storage_key IS NOT NULL',
      [mailboxId]
    );
    for (const msg of msgs) {
      if (msg.raw_storage_key) {
        await storage.delete(msg.raw_storage_key).catch(() => {});
      }
    }
    await db.query('DELETE FROM messages WHERE mailbox_id = $1', [mailboxId]);
  } else {
    // Unlink messages but preserve data
    await db.query('UPDATE messages SET mailbox_id = NULL WHERE mailbox_id = $1', [mailboxId]);
  }

  await db.query('DELETE FROM connected_mailboxes WHERE id = $1', [mailboxId]);
}

/**
 * Inbound-Only Security Barrier Check:
 * Checks if a sender address corresponds to any active connected mailbox.
 * Returns true if the address belongs to a connected mailbox (and therefore MUST be blocked from sending).
 */
export async function isSenderConnectedMailbox(fromAddress: string, workspaceId = 'default'): Promise<boolean> {
  if (!fromAddress) return false;
  // Extract pure email address from "Name <email@domain.com>" or "email@domain.com"
  const match = fromAddress.match(/<([^>]+)>/) || [null, fromAddress];
  const cleanEmail = (match[1] || fromAddress).trim().toLowerCase();

  const { rows: [mb] } = await db.query(`
    SELECT id FROM connected_mailboxes 
    WHERE lower(email) = $1 AND workspace_id = $2
    LIMIT 1
  `, [cleanEmail, workspaceId]);

  return Boolean(mb);
}

/**
 * Ingest an RFC 822 MIME buffer downloaded from a connected mailbox into Letterdock.
 */
export async function ingestConnectedMime(options: {
  mailboxId: string;
  workspaceId: string;
  rawMime: Buffer;
  providerMessageId?: string;
  receivedAt?: Date;
}): Promise<{ id: string; isDuplicate: boolean }> {
  const { mailboxId, workspaceId, rawMime, providerMessageId, receivedAt = new Date() } = options;

  // 1. Fast parse headers to extract Message-ID and sender/recipient
  const parsed = await simpleParser(rawMime, { skipImageLinks: true });
  const messageIdHeader = parsed.messageId || providerMessageId || null;

  // 2. Duplicate prevention check via Message-ID or provider message ID
  if (messageIdHeader) {
    const { rows: [existing] } = await db.query(`
      SELECT id FROM messages 
      WHERE workspace_id = $1 AND (message_id = $2 OR headers->>'x-provider-id' = $2)
      LIMIT 1
    `, [workspaceId, messageIdHeader]);

    if (existing) {
      return { id: existing.id, isDuplicate: true };
    }
  }

  const id = randomUUID();
  const rawKey = `messages/raw/${id}.eml`;
  const stored = await storage.put(rawKey, rawMime, { contentType: 'message/rfc822' });

  // Resolve recipient and sender
  const { rows: [mb] } = await db.query('SELECT email FROM connected_mailboxes WHERE id = $1', [mailboxId]);
  const recipient = (parsed.to && 'text' in parsed.to ? parsed.to.text : mb?.email || 'unknown').toLowerCase();
  const sender = (parsed.from && 'text' in parsed.from ? parsed.from.text : 'unknown').toLowerCase();
  const domainPart = recipient.slice(recipient.lastIndexOf('@') + 1).toLowerCase() || 'connected.local';

  // Ensure domain exists in domains table (unverified for outbound relay)
  await db.query(`
    INSERT INTO domains(name, verified, retention_days)
    VALUES($1, false, 30)
    ON CONFLICT (name) DO NOTHING
  `, [domainPart]);

  const headersObj = {
    ...Object.fromEntries(parsed.headers),
    'x-letterdock-source': 'connected_mailbox',
    'x-provider-id': providerMessageId || ''
  };

  // 3. Insert into messages table with state='pending' for asynchronous parsing & attachment indexing
  await db.query(`
    INSERT INTO messages(
      id, domain, sender, recipient, subject,
      raw_storage_key, raw_checksum_sha256, raw_size_bytes,
      headers, message_id, state, received, unread, folder,
      workspace_id, mailbox_id
    )
    VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, true, 'inbox', $12, $13)
  `, [
    id, domainPart, sender, recipient, parsed.subject || '(No Subject)',
    stored.key, stored.sha256, stored.size,
    JSON.stringify(headersObj), messageIdHeader, receivedAt,
    workspaceId, mailboxId
  ]);

  // Ensure inbox record exists
  await db.query(`
    INSERT INTO inboxes(address) VALUES($1)
    ON CONFLICT(address) DO UPDATE SET removed_at = NULL WHERE inboxes.removed_at IS NOT NULL
  `, [recipient]);

  return { id, isDuplicate: false };
}

/**
 * Execute incremental synchronization for a connected mailbox.
 */
export async function syncConnectedMailbox(mailboxId: string, maxMessages = 25): Promise<{
  ingested: number;
  skipped: number;
  cursor: string | null;
}> {
  const { rows: [mb] } = await db.query(`
    SELECT id, workspace_id, provider, email, sync_cursor, status
    FROM connected_mailboxes WHERE id = $1
  `, [mailboxId]);

  if (!mb) throw new Error(`Connected mailbox ${mailboxId} not found.`);
  if (mb.status === 'paused' || mb.status === 'revoked') {
    return { ingested: 0, skipped: 0, cursor: mb.sync_cursor };
  }

  const token = await getValidAccessToken(mailboxId);
  let ingested = 0;
  let skipped = 0;
  let nextCursor: string | null = mb.sync_cursor;

  try {
    if (mb.provider === 'google') {
      // 1. Fetch message list from Gmail API
      const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      listUrl.searchParams.set('maxResults', String(maxMessages));
      if (mb.sync_cursor) {
        listUrl.searchParams.set('pageToken', mb.sync_cursor);
      }

      const listRes = await fetch(listUrl.href, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000)
      });

      if (!listRes.ok) {
        throw new Error(`Gmail API message list failed (${listRes.status}): ${await listRes.text()}`);
      }

      const listData = await listRes.json() as {
        messages?: Array<{ id: string; threadId: string }>;
        nextPageToken?: string;
      };

      const messages = listData.messages || [];
      for (const msgSummary of messages) {
        // Download raw RFC 822 MIME
        const getUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgSummary.id}?format=raw`;
        const getRes = await fetch(getUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000)
        });

        if (!getRes.ok) continue;

        const msgData = await getRes.json() as { raw?: string; internalDate?: string };
        if (!msgData.raw) continue;

        // Base64url decode raw MIME
        const rawBuffer = Buffer.from(msgData.raw, 'base64url');
        const receivedAt = msgData.internalDate ? new Date(Number(msgData.internalDate)) : new Date();

        const result = await ingestConnectedMime({
          mailboxId,
          workspaceId: mb.workspace_id,
          rawMime: rawBuffer,
          providerMessageId: msgSummary.id,
          receivedAt
        });

        if (result.isDuplicate) {
          skipped++;
        } else {
          ingested++;
        }
      }

      nextCursor = listData.nextPageToken || null;
    } else {
      // Microsoft Graph API Delta Query / Messages Ingestion
      const listUrl = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages');
      listUrl.searchParams.set('$top', String(maxMessages));
      listUrl.searchParams.set('$select', 'id,internetMessageId,receivedDateTime,subject');
      listUrl.searchParams.set('$orderby', 'receivedDateTime desc');

      const listRes = await fetch(listUrl.href, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000)
      });

      if (!listRes.ok) {
        throw new Error(`Microsoft Graph API messages list failed (${listRes.status}): ${await listRes.text()}`);
      }

      const listData = await listRes.json() as {
        value?: Array<{ id: string; internetMessageId?: string; receivedDateTime?: string }>;
        '@odata.nextLink'?: string;
      };

      const messages = listData.value || [];
      for (const msg of messages) {
        // Download raw RFC 822 MIME content
        const rawRes = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${msg.id}/\$value`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000)
        });

        if (!rawRes.ok) continue;

        const arrayBuf = await rawRes.arrayBuffer();
        const rawBuffer = Buffer.from(arrayBuf);
        const receivedAt = msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date();

        const result = await ingestConnectedMime({
          mailboxId,
          workspaceId: mb.workspace_id,
          rawMime: rawBuffer,
          providerMessageId: msg.id,
          receivedAt
        });

        if (result.isDuplicate) {
          skipped++;
        } else {
          ingested++;
        }
      }
    }

    // Update mailbox sync state
    await db.query(`
      UPDATE connected_mailboxes
      SET last_synced_at = now(), sync_cursor = $1, status = 'active', last_error = NULL, updated_at = now()
      WHERE id = $2
    `, [nextCursor, mailboxId]);

    return { ingested, skipped, cursor: nextCursor };
  } catch (err: any) {
    await db.query(`
      UPDATE connected_mailboxes
      SET last_error = $1, updated_at = now()
      WHERE id = $2
    `, [err.message || String(err), mailboxId]);
    throw err;
  }
}
