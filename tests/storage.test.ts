import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { S3StorageService } from '../src/data/storage/s3.storage.js';
import { createStorageService } from '../src/data/storage/storage.factory.js';
import { LocalStorageService } from '../src/data/storage/storage.service.js';

import { TEST_AUTH_ENV } from './helpers/auth.js';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';

function fakeS3(objects = new Map<string, Uint8Array>()) {
  const send = vi.fn((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      objects.set(command.input.Key!, command.input.Body as Uint8Array);
      return Promise.resolve({});
    }
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key!);
      return Promise.resolve({
        Body: body ? { transformToByteArray: () => Promise.resolve(body) } : undefined,
      });
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(command.input.Key!);
      return Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { client: { send } as unknown as S3Client, send, objects };
}

describe('S3StorageService (S3 / MinIO)', () => {
  it('stores objects under the tenant prefix with content type and encryption', async () => {
    const { client, send } = fakeS3();
    const storage = new S3StorageService({
      bucket: 'sinfonia-attachments',
      region: 'eu-south-1',
      serverSideEncryption: 'AES256',
      client,
    });

    const result = await storage.save(
      tenantA,
      '../../fattura marzo.pdf',
      Buffer.from('%PDF-1'),
      'application/pdf',
    );

    expect(result.fileSize).toBe(6);
    expect(result.storagePath).toMatch(
      new RegExp(`^${tenantA}/attachments/[0-9a-f-]{36}_fattura_marzo\\.pdf$`),
    );
    const put = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: 'sinfonia-attachments',
      Key: result.storagePath,
      ContentType: 'application/pdf',
      ServerSideEncryption: 'AES256',
    });
  });

  it('reads and deletes only inside the caller tenant prefix', async () => {
    const { client, objects } = fakeS3();
    const storage = new S3StorageService({ bucket: 'b', region: 'eu-south-1', client });
    const { storagePath } = await storage.save(tenantA, 'ddt.jpg', Buffer.from('jpeg-bytes'));

    expect((await storage.read(tenantA, storagePath)).toString()).toBe('jpeg-bytes');
    await expect(storage.read(tenantB, storagePath)).rejects.toThrow(/Access denied/);
    await expect(storage.delete(tenantB, storagePath)).rejects.toThrow(/Access denied/);
    await expect(
      storage.read(tenantA, `${tenantA}/attachments/../../${tenantB}/attachments/x`),
    ).rejects.toThrow(/Access denied/);

    await storage.delete(tenantA, storagePath);
    expect(objects.has(storagePath)).toBe(false);
  });
});

describe('LocalStorageService path traversal', () => {
  const baseDir = path.resolve(process.cwd(), '.runtime', 'test-storage-prefix');

  afterAll(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('rejects a sibling directory that shares the tenant prefix', async () => {
    const storage = new LocalStorageService(baseDir);
    await fs.mkdir(path.join(baseDir, `${tenantA}-other`), { recursive: true });
    await fs.writeFile(path.join(baseDir, `${tenantA}-other`, 'secret.txt'), 'x');

    await expect(storage.read(tenantA, `${tenantA}-other/secret.txt`)).rejects.toThrow(
      /Access denied/,
    );
  });
});

describe('Storage configuration', () => {
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://dummy:dummy@localhost:5432/dummy',
    ...TEST_AUTH_ENV,
  };

  it('uses local storage by default', () => {
    expect(createStorageService(loadConfig(base))).toBeInstanceOf(LocalStorageService);
  });

  it('builds the S3 adapter for MinIO settings', () => {
    const config = loadConfig({
      ...base,
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'sinfonia',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'minio-test-user',
      S3_SECRET_ACCESS_KEY: 'minio-test-password',
    });
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
    expect(config.S3_REGION).toBe('eu-south-1');
    expect(createStorageService(config)).toBeInstanceOf(S3StorageService);
  });

  it('fails fast when the S3 driver has no bucket', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });
});
