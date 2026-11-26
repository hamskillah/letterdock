import { db } from '../src/db.js';
import { getEncryptionKey, encryptSecret, decryptSecret } from '../src/crypto.js';
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync, createHash } from 'node:crypto';

function deriveHkdfKey(keyInput: string, purpose: string): Buffer {
  const trimmed = keyInput.trim();
  const isHex64 = /^[0-9a-fA-F]{64}$/.test(trimmed);
  const ikm = Buffer.from(trimmed, isHex64 ? 'hex' : 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, 'letterdock-salt', 'letterdock:' + purpose, 32));
}

function deriveSessionSecretKey(keyInput: string, purpose: string): Buffer {
  return createHash('sha256').update('letterdock-' + purpose + ':' + keyInput.trim()).digest();
}

function decryptCandidate(encoded: string, key: Buffer): string {
  const parts = encoded.split('.');
  if (parts.length === 4 && parts[0] === 'v1') {
    const [, ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } else if (parts.length === 3) {
    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
  throw new Error('Unsupported encrypted payload format');
}

function decryptWithFallback(encoded: string, keyInput: string, purpose: string): string {
  try {
    const hkdfKey = deriveHkdfKey(keyInput, purpose);
    return decryptCandidate(encoded, hkdfKey);
  } catch {
    const sessionKey = deriveSessionSecretKey(keyInput, purpose);
    return decryptCandidate(encoded, sessionKey);
  }
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export async function rotateAllSecrets(
  oldKeyString: string,
  newKeyString: string,
  options?: { strict?: boolean }
): Promise<{
  hooksRotated: number;
  outboundProfilesRotated: number;
  cloudflareTokensRotated: number;
  skippedUndecryptable: number;
}> {
  if (!oldKeyString || oldKeyString.length < 16) {
    throw new Error('Old encryption key must be at least 16 characters long');
  }
  if (!newKeyString || newKeyString.length < 32) {
    throw new Error('New encryption key must be at least 32 characters long');
  }

  const isStrict = options?.strict ?? false;
  const client = await db.connect();
  let hooksRotated = 0;
  let outboundProfilesRotated = 0;
  let cloudflareTokensRotated = 0;
  let skippedUndecryptable = 0;

  try {
    await client.query('BEGIN');

    // 1. Rotate Webhook Secrets
    const newWebhookKey = deriveHkdfKey(newKeyString, 'webhook');
    const { rows: hooks } = await client.query('SELECT id, secret FROM hooks FOR UPDATE');
    for (const hook of hooks) {
      if (!hook.secret) continue;
      try {
        const plaintext = decryptWithFallback(hook.secret, oldKeyString, 'webhook');
        const reEncrypted = encryptWithKey(plaintext, newWebhookKey);
        const verified = decryptCandidate(reEncrypted, newWebhookKey);
        if (verified !== plaintext) throw new Error('Verification failed for hook ' + hook.id);
        await client.query('UPDATE hooks SET secret = $2 WHERE id = $1', [hook.id, reEncrypted]);
        hooksRotated++;
      } catch (err) {
        if (isStrict) throw err;
        skippedUndecryptable++;
      }
    }

    // 2. Rotate Outbound Relay Credentials
    const newOutboundKey = deriveHkdfKey(newKeyString, 'outbound');
    const { rows: profiles } = await client.query('SELECT id, credentials_encrypted FROM outbound_profiles FOR UPDATE');
    for (const profile of profiles) {
      if (!profile.credentials_encrypted) continue;
      try {
        const plaintext = decryptWithFallback(profile.credentials_encrypted, oldKeyString, 'outbound');
        const reEncrypted = encryptWithKey(plaintext, newOutboundKey);
        const verified = decryptCandidate(reEncrypted, newOutboundKey);
        if (verified !== plaintext) throw new Error('Verification failed for profile ' + profile.id);
        await client.query('UPDATE outbound_profiles SET credentials_encrypted = $2 WHERE id = $1', [profile.id, reEncrypted]);
        outboundProfilesRotated++;
      } catch (err) {
        if (isStrict) throw err;
        skippedUndecryptable++;
      }
    }

    // 3. Rotate Cloudflare Token
    const newCfKey = deriveHkdfKey(newKeyString, 'cloudflare-token');
    const { rows: settings } = await client.query(`SELECT key, value FROM settings WHERE key = 'cloudflare_token' FOR UPDATE`);
    for (const setting of settings) {
      if (!setting.value) continue;
      try {
        const plaintext = decryptWithFallback(setting.value, oldKeyString, 'cloudflare-token');
        const reEncrypted = encryptWithKey(plaintext, newCfKey);
        const verified = decryptCandidate(reEncrypted, newCfKey);
        if (verified !== plaintext) throw new Error('Verification failed for cloudflare_token');
        await client.query(`UPDATE settings SET value = $2 WHERE key = 'cloudflare_token'`, [reEncrypted]);
        cloudflareTokensRotated++;
      } catch (err) {
        if (isStrict) throw err;
        skippedUndecryptable++;
      }
    }

    await client.query('COMMIT');
    return { hooksRotated, outboundProfilesRotated, cloudflareTokensRotated, skippedUndecryptable };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// CLI usage
if (process.argv[1]?.endsWith('rotate-keys.ts')) {
  const oldKey = process.argv[2] || process.env.OLD_ENCRYPTION_KEY;
  const newKey = process.argv[3] || process.env.NEW_ENCRYPTION_KEY;

  if (!oldKey || !newKey) {
    console.error('Usage: tsx scripts/rotate-keys.ts <OLD_KEY> <NEW_KEY>');
    process.exit(1);
  }

  rotateAllSecrets(oldKey, newKey)
    .then((stats) => {
      console.log('Key rotation completed successfully:');
      console.log(`- Webhooks re-encrypted: ${stats.hooksRotated}`);
      console.log(`- Outbound profiles re-encrypted: ${stats.outboundProfilesRotated}`);
      console.log(`- Cloudflare tokens re-encrypted: ${stats.cloudflareTokensRotated}`);
      if (stats.skippedUndecryptable > 0) {
        console.warn(`- Skipped unreadable records: ${stats.skippedUndecryptable}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('Key rotation failed:', err);
      process.exit(1);
    });
}
