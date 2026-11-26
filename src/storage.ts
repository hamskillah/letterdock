import { mkdir, readFile, unlink, stat, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './crypto.js';

export interface StoragePutResult {
  key: string;
  size: number;
  sha256: string;
}

export interface StorageGetResult {
  data: Buffer;
  size: number;
  sha256?: string;
  contentType?: string;
}

export interface BlobStorage {
  put(key: string, data: Buffer, options?: { contentType?: string }): Promise<StoragePutResult>;
  get(key: string): Promise<StorageGetResult | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function sanitizeKey(key: string): string {
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..') || !/^[a-zA-Z0-9_\-\.\/]+$/.test(normalized)) {
    throw new Error('Invalid storage key: ' + key);
  }
  return normalized;
}

export class LocalStorageDriver implements BlobStorage {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = resolve(baseDir || process.env.STORAGE_PATH || './data/storage');
  }

  private filePath(key: string): string {
    const safeKey = sanitizeKey(key);
    const target = resolve(this.baseDir, safeKey);
    if (!target.startsWith(this.baseDir)) {
      throw new Error('Storage path traversal detected');
    }
    return target;
  }

  async put(key: string, data: Buffer, _options?: { contentType?: string }): Promise<StoragePutResult> {
    const targetPath = this.filePath(key);
    await mkdir(dirname(targetPath), { recursive: true });

    const tempPath = targetPath + '.' + randomUUID() + '.tmp';
    await writeFile(tempPath, data);
    await rename(tempPath, targetPath);

    return {
      key,
      size: data.length,
      sha256: sha256(data)
    };
  }

  async get(key: string): Promise<StorageGetResult | null> {
    const targetPath = this.filePath(key);
    try {
      const data = await readFile(targetPath);
      return {
        data,
        size: data.length,
        sha256: sha256(data)
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const targetPath = this.filePath(key);
    try {
      await unlink(targetPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    const targetPath = this.filePath(key);
    try {
      await stat(targetPath);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }
}

export class S3StorageDriver implements BlobStorage {
  private bucket: string;
  private clientPromise: Promise<any>;

  constructor(bucket?: string, endpoint?: string, region = 'auto', accessKeyId?: string, secretAccessKey?: string) {
    this.bucket = bucket || process.env.S3_BUCKET || 'letterdock';
    const s3Endpoint = endpoint || process.env.S3_ENDPOINT;
    const keyId = accessKeyId || process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    const secret = secretAccessKey || process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    const s3Region = region || process.env.S3_REGION || 'auto';

    this.clientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => {
      return new S3Client({
        region: s3Region,
        endpoint: s3Endpoint,
        credentials: keyId && secret ? { accessKeyId: keyId, secretAccessKey: secret } : undefined,
        forcePathStyle: true
      });
    });
  }

  async put(key: string, data: Buffer, options?: { contentType?: string }): Promise<StoragePutResult> {
    const client = await this.clientPromise;
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const safeKey = sanitizeKey(key);

    await client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: safeKey,
      Body: data,
      ContentType: options?.contentType || 'application/octet-stream'
    }));

    return {
      key: safeKey,
      size: data.length,
      sha256: sha256(data)
    };
  }

  async get(key: string): Promise<StorageGetResult | null> {
    const client = await this.clientPromise;
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const safeKey = sanitizeKey(key);

    try {
      const response = await client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: safeKey
      }));

      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks);

      return {
        data,
        size: data.length,
        sha256: sha256(data),
        contentType: response.ContentType
      };
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const client = await this.clientPromise;
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const safeKey = sanitizeKey(key);

    try {
      await client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: safeKey
      }));
    } catch (err: any) {
      if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) {
        throw err;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    const client = await this.clientPromise;
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const safeKey = sanitizeKey(key);

    try {
      await client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: safeKey
      }));
      return true;
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }
}

export function createStorageDriver(): BlobStorage {
  if (process.env.STORAGE_DRIVER === 's3' && process.env.S3_BUCKET) {
    return new S3StorageDriver();
  }
  return new LocalStorageDriver();
}

export const storage: BlobStorage = createStorageDriver();
