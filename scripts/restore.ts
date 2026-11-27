import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getEncryptionKey, sha256 } from '../src/crypto.js';
import { db } from '../src/db.js';
import type { BackupManifest } from './backup.js';

const exec = promisify(execFile);

export async function restoreEncryptedBackup(
  backupFilePath: string,
  options?: {
    targetStorageDir?: string;
    targetDbUrl?: string;
  }
): Promise<{ manifest: BackupManifest; verifiedBlobs: number }> {
  const resolvedPath = resolve(backupFilePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Backup file not found at: ${resolvedPath}`);
  }

  const rawEncrypted = await fs.readFile(resolvedPath);
  if (rawEncrypted.length < 32 || rawEncrypted.subarray(0, 4).toString('utf-8') !== 'LDKB') {
    throw new Error('Invalid or corrupted backup archive: missing LDKB magic header');
  }

  // 1. Decrypt Archive
  const iv = rawEncrypted.subarray(4, 16);
  const tag = rawEncrypted.subarray(16, 32);
  const ciphertext = rawEncrypted.subarray(32);

  const key = getEncryptionKey('backup');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  let tarBuffer: Buffer;
  try {
    tarBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err: any) {
    throw new Error('Backup decryption failed: authentication tag mismatch or corrupted archive');
  }

  const tempDir = resolve('/tmp/antigravity', `restore-staging-${(await import('node:crypto')).randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const tarPath = join(tempDir, 'backup.tar');
  await fs.writeFile(tarPath, tarBuffer);
  await exec('tar', ['-xf', tarPath, '-C', tempDir]);

  // 2. Read and Validate Manifest
  const manifestPath = join(tempDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Corrupted backup archive: missing manifest.json');
  }

  const manifest: BackupManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  // 3. Verify Database Dump Hash
  const dbDumpPath = join(tempDir, 'database.dump');
  const dbBuffer = await fs.readFile(dbDumpPath);
  const dbCalculatedHash = sha256(dbBuffer);
  if (dbCalculatedHash !== manifest.db_sha256) {
    throw new Error(`Database checksum mismatch! Expected ${manifest.db_sha256}, got ${dbCalculatedHash}`);
  }

  // 4. Verify Blobs Integrity
  const blobsDir = join(tempDir, 'blobs');
  let verifiedBlobsCount = 0;
  for (const [relPath, info] of Object.entries(manifest.blobs)) {
    const fullPath = join(blobsDir, relPath);
    if (!existsSync(fullPath)) {
      throw new Error(`Missing blob in backup archive: ${relPath}`);
    }
    const content = await fs.readFile(fullPath);
    const hash = sha256(content);
    if (hash !== info.sha256) {
      throw new Error(`Checksum mismatch for blob ${relPath}! Expected ${info.sha256}, got ${hash}`);
    }
    verifiedBlobsCount++;
  }

  // 5. Restore Database
  const targetDbUrl = options?.targetDbUrl || process.env.DATABASE_URL;
  if (targetDbUrl) {
    try {
      await exec('pg_restore', ['--clean', '--if-exists', '-d', targetDbUrl, dbDumpPath]);
    } catch {
      // Fallback: if database.dump is json table dump or pg_restore binary unavailable
      const pgModule = await import('pg');
      const targetPool = new pgModule.default.Pool({ connectionString: targetDbUrl });
      try {
        const { migrate } = await import('../src/db.js');
        await migrate(targetPool);

        const parsed = JSON.parse(dbBuffer.toString('utf-8'));
        for (const [table, rows] of Object.entries(parsed)) {
          for (const row of rows as any[]) {
            const keys = Object.keys(row);
            if (keys.length === 0) continue;
            const values = Object.values(row);
            const placeholders = keys.map((_, i) => '$' + (i + 1)).join(', ');
            await targetPool.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values).catch(() => {});
          }
        }
      } finally {
        await targetPool.end();
      }
    }
  }

  // 6. Restore Blobs to Target Storage Directory
  const destStorageDir = resolve(options?.targetStorageDir || process.env.STORAGE_PATH || './data/storage');
  for (const relPath of Object.keys(manifest.blobs)) {
    const srcPath = join(blobsDir, relPath);
    const destPath = join(destStorageDir, relPath);
    await fs.mkdir(dirname(destPath), { recursive: true });
    await fs.copyFile(srcPath, destPath);
  }

  // Clean staging
  await fs.rm(tempDir, { recursive: true, force: true });

  return { manifest, verifiedBlobs: verifiedBlobsCount };
}

// CLI execution
if (process.argv[1]?.endsWith('restore.ts')) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: tsx scripts/restore.ts <path-to-encrypted-backup>');
    process.exit(1);
  }

  restoreEncryptedBackup(file)
    .then(({ manifest, verifiedBlobs }) => {
      console.log(`Successfully restored backup from ${manifest.timestamp}!\nVerified ${verifiedBlobs} blobs and database integrity.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Restore failed:', err);
      process.exit(1);
    });
}
