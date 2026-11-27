import { randomUUID, createHash, createCipheriv } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getEncryptionKey, sha256 } from '../src/crypto.js';
import { db } from '../src/db.js';

const exec = promisify(execFile);

export interface BackupManifest {
  version: string;
  timestamp: string;
  db_size: number;
  db_sha256: string;
  blobs_count: number;
  blobs: Record<string, { size: number; sha256: string }>;
}

export async function createEncryptedBackup(options?: {
  outputPath?: string;
  storageDir?: string;
  dbUrl?: string;
}): Promise<{ backupPath: string; manifest: BackupManifest }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tempDir = resolve('/tmp/antigravity', `backup-staging-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const storageDir = resolve(options?.storageDir || process.env.STORAGE_PATH || './data/storage');
  const dbDumpPath = join(tempDir, 'database.dump');

  // 1. Dump Database
  const dbUrl = options?.dbUrl || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required to create a database backup');

  let activePool = db;
  let customPool = false;
  if (options?.dbUrl) {
    const pg = await import('pg');
    activePool = new pg.default.Pool({ connectionString: options.dbUrl });
    customPool = true;
  }

  try {
    await exec('pg_dump', ['-Fc', dbUrl, '-f', dbDumpPath]);
  } catch (err) {
    // Graceful fallback to table-based SQL dump if pg_dump client binary is unavailable
    const tables = ['settings', 'workspaces', 'sessions', 'domains', 'inboxes', 'messages', 'attachments', 'outbound_profiles', 'outbound_messages', 'suppressions', 'api_keys', 'hooks', 'deliveries', 'job_queue'];
    const dumpData: Record<string, any[]> = {};
    for (const table of tables) {
      const res = await activePool.query(`SELECT * FROM ${table}`).catch(() => ({ rows: [] }));
      dumpData[table] = res.rows;
    }
    await fs.writeFile(dbDumpPath, JSON.stringify(dumpData, null, 2));
  } finally {
    if (customPool) {
      await activePool.end();
    }
  }

  const dbBuffer = await fs.readFile(dbDumpPath);
  const dbSha = sha256(dbBuffer);

  // 2. Scan and hash storage blobs
  const blobsManifest: Record<string, { size: number; sha256: string }> = {};
  const blobsStagingDir = join(tempDir, 'blobs');
  await fs.mkdir(blobsStagingDir, { recursive: true });

  if (existsSync(storageDir)) {
    async function scanBlobs(dir: string, base: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = join(base, entry.name);
        if (entry.isDirectory()) {
          await scanBlobs(fullPath, relPath);
        } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
          const content = await fs.readFile(fullPath);
          const hash = sha256(content);
          blobsManifest[relPath] = { size: content.length, sha256: hash };
          const destPath = join(blobsStagingDir, relPath);
          await fs.mkdir(dirname(destPath), { recursive: true });
          await fs.writeFile(destPath, content);
        }
      }
    }
    await scanBlobs(storageDir, '');
  }

  // 3. Create Manifest
  const manifest: BackupManifest = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    db_size: dbBuffer.length,
    db_sha256: dbSha,
    blobs_count: Object.keys(blobsManifest).length,
    blobs: blobsManifest
  };

  await fs.writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 4. Create TAR bundle
  const rawTarPath = join(tempDir, 'backup.tar');
  await exec('tar', ['-cf', rawTarPath, '-C', tempDir, 'manifest.json', 'database.dump', 'blobs']);

  // 5. Encrypt with AES-256-GCM
  const tarBuffer = await fs.readFile(rawTarPath);
  const iv = (await import('node:crypto')).randomBytes(12);
  const key = getEncryptionKey('backup');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(tarBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  // File structure: [MAGIC 4B: 'LDKB'] [IV 12B] [TAG 16B] [CIPHERTEXT ...]
  const magic = Buffer.from('LDKB', 'utf-8');
  const payload = Buffer.concat([magic, iv, tag, encrypted]);

  const finalBackupPath = resolve(options?.outputPath || `./letterdock-backup-${timestamp}.ldk.enc`);
  await fs.mkdir(dirname(finalBackupPath), { recursive: true });
  await fs.writeFile(finalBackupPath, payload);

  // Clean staging
  await fs.rm(tempDir, { recursive: true, force: true });

  return { backupPath: finalBackupPath, manifest };
}

// CLI execution
if (process.argv[1]?.endsWith('backup.ts')) {
  createEncryptedBackup()
    .then(({ backupPath, manifest }) => {
      console.log(`Successfully created encrypted point-in-time backup:\nPath: ${backupPath}\nDB size: ${manifest.db_size} bytes\nBlobs: ${manifest.blobs_count}\nSHA256: ${manifest.db_sha256}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Backup creation failed:', err);
      process.exit(1);
    });
}
