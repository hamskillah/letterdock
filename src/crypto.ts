import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, hkdfSync } from 'node:crypto';

let warnedMissingKey = false;

export function getEncryptionKey(purpose: string): Buffer {
  const customKey = process.env.APP_ENCRYPTION_KEY;
  if (customKey && customKey.trim().length >= 32) {
    // HKDF to derive 32-byte key for specific purpose
    const ikm = Buffer.from(customKey.trim(), customKey.trim().length === 64 ? 'hex' : 'utf8');
    return Buffer.from(hkdfSync('sha256', ikm, 'letterdock-salt', 'letterdock:' + purpose, 32));
  }

  // Graceful fallback to SESSION_SECRET for backward compatibility
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('Neither APP_ENCRYPTION_KEY nor SESSION_SECRET is available');
  }

  if (!warnedMissingKey && process.env.NODE_ENV === 'production') {
    warnedMissingKey = true;
    console.warn('[SECURITY WARNING] APP_ENCRYPTION_KEY is not set. Falling back to SESSION_SECRET derivation.');
  }

  return createHash('sha256').update('letterdock-' + purpose + ':' + sessionSecret).digest();
}

/**
 * Encrypt a plaintext secret using AES-256-GCM.
 * Output format: "v1.<base64-iv>.<base64-tag>.<base64-ciphertext>"
 */
export function encryptSecret(value: string, purpose: string): string {
  const iv = randomBytes(12); // 96-bit nonce standard for GCM
  const key = getEncryptionKey(purpose);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

/**
 * Decrypt a secret. Handles both new versioned "v1.iv.tag.ciphertext"
 * and legacy 3-part "iv.tag.ciphertext" encrypted using SESSION_SECRET.
 */
export function decryptSecret(encoded: string, purpose: string): string {
  if (!encoded || typeof encoded !== 'string') {
    throw new Error('Invalid encoded secret');
  }

  const parts = encoded.split('.');
  
  if (parts.length === 4 && parts[0] === 'v1') {
    const [, ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(dataB64, 'base64');
    const key = getEncryptionKey(purpose);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  if (parts.length === 3) {
    // Legacy format: "iv.tag.ciphertext" derived strictly from SESSION_SECRET
    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(dataB64, 'base64');

    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) throw new Error('SESSION_SECRET required to decrypt legacy secret');
    const legacyKey = createHash('sha256').update('letterdock-' + purpose + ':' + sessionSecret).digest();

    const decipher = createDecipheriv('aes-256-gcm', legacyKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  throw new Error('Unsupported encrypted secret format');
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
