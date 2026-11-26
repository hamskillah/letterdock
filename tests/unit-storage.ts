import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalStorageDriver } from '../src/storage.js';

const testDir = resolve('./data/test-storage-' + Date.now());
const driver = new LocalStorageDriver(testDir);

try {
  // 1. Put object
  const content = Buffer.from('hello letterdock blob storage');
  const res = await driver.put('mail/attachments/receipt.pdf', content);
  assert.equal(res.key, 'mail/attachments/receipt.pdf');
  assert.equal(res.size, content.length);
  assert.equal(res.sha256, '345ac091d88c1c32d16f964ebaf36444fc4adcb76ed4e86d8c48447fc81b7956');

  // 2. Put object with consecutive dots in filename
  const dotRes = await driver.put('mail/attachments/report..final..2026.pdf', Buffer.from('dot-content'));
  assert.equal(dotRes.key, 'mail/attachments/report..final..2026.pdf');
  const dotGet = await driver.get('mail/attachments/report..final..2026.pdf');
  assert(dotGet !== null);
  assert.equal(dotGet.data.toString(), 'dot-content');

  // 3. Exists
  assert.equal(await driver.exists('mail/attachments/receipt.pdf'), true);
  assert.equal(await driver.exists('mail/non-existent.pdf'), false);

  // 4. Get object
  const retrieved = await driver.get('mail/attachments/receipt.pdf');
  assert(retrieved !== null);
  assert.equal(retrieved.data.toString(), 'hello letterdock blob storage');
  assert.equal(retrieved.size, content.length);

  // 5. Path traversal protection
  await assert.rejects(async () => {
    await driver.put('../escaped.txt', Buffer.from('bad'));
  }, /Storage path traversal|Invalid storage key/);

  await assert.rejects(async () => {
    await driver.put('mail/attachments/../../escaped.txt', Buffer.from('bad'));
  }, /Storage path traversal|Invalid storage key/);

  // 6. Delete object
  await driver.delete('mail/attachments/receipt.pdf');
  assert.equal(await driver.exists('mail/attachments/receipt.pdf'), false);
  assert.equal(await driver.get('mail/attachments/receipt.pdf'), null);

  console.log('All storage driver tests passed successfully!');
} finally {
  await rm(testDir, { recursive: true, force: true });
}
