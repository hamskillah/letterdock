import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, sha256 } from '../src/crypto.js';

// 1. Test legacy decryption compatibility
process.env.SESSION_SECRET = 'super-secret-session-key-at-least-32-chars';
delete process.env.APP_ENCRYPTION_KEY;

const legacyPurpose = 'test-purpose';
const legacySecretVal = 'legacy-secret-content-12345';
const legacyKey = createHash('sha256').update('letterdock-' + legacyPurpose + ':' + process.env.SESSION_SECRET).digest();
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
const legacyEnc = Buffer.concat([cipher.update(legacySecretVal, 'utf8'), cipher.final()]);
const legacyEncoded = [iv.toString('base64'), cipher.getAuthTag().toString('base64'), legacyEnc.toString('base64')].join('.');

const decryptedLegacy = decryptSecret(legacyEncoded, legacyPurpose);
assert.equal(decryptedLegacy, legacySecretVal, 'Legacy secret should decrypt correctly');

// 2. Test new encryption without APP_ENCRYPTION_KEY (fallback mode under SESSION_SECRET)
const fallbackEnc = encryptSecret('fallback-value', 'test-purpose');
assert(fallbackEnc.startsWith('v1.'), 'New encryption must start with v1.');
assert.equal(decryptSecret(fallbackEnc, 'test-purpose'), 'fallback-value');

// 3. Test with dedicated APP_ENCRYPTION_KEY (hex 64 chars = 32 bytes)
process.env.APP_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const modernEnc = encryptSecret('modern-value-456', 'modern-purpose');
assert(modernEnc.startsWith('v1.'));
assert.equal(decryptSecret(modernEnc, 'modern-purpose'), 'modern-value-456');

// 4. Ensure legacy still decrypts even when APP_ENCRYPTION_KEY is set
assert.equal(decryptSecret(legacyEncoded, legacyPurpose), legacySecretVal, 'Legacy secret must still decrypt when APP_ENCRYPTION_KEY is active');

// 5. Ensure v1 secret encrypted under SESSION_SECRET still decrypts after APP_ENCRYPTION_KEY is configured
assert.equal(decryptSecret(fallbackEnc, 'test-purpose'), 'fallback-value', 'v1 secret encrypted under SESSION_SECRET fallback must still decrypt');

// 6. Test with 64-char non-hex ASCII passphrase (ensures no zero-entropy IKM bug)
process.env.APP_ENCRYPTION_KEY = 'non-hex-ascii-secret-key-that-is-strictly-sixty-four-characters!';
assert.equal(process.env.APP_ENCRYPTION_KEY.length, 64);
const asciiEnc = encryptSecret('ascii-content', 'ascii-purpose');
assert.equal(decryptSecret(asciiEnc, 'ascii-purpose'), 'ascii-content');

// 7. Test sha256 helper
assert.equal(sha256('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');

console.log('All crypto tests passed successfully!');
