import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';

import type { StorageResult, StorageService } from './storage.service.js';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible services (MinIO); omit for AWS S3. */
  endpoint?: string;
  /** Path-style URLs (`endpoint/bucket/key`), required by most MinIO setups. */
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Optional server-side encryption applied to every object. */
  serverSideEncryption?: ServerSideEncryption;
  /** Injected client, for tests. */
  client?: S3Client;
}

/**
 * S3 / MinIO attachment storage with per-tenant key prefixes (`<tenantId>/attachments/...`).
 * Reads and deletes are only allowed inside the caller's tenant prefix.
 */
export class S3StorageService implements StorageService {
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        endpoint: options.endpoint,
        forcePathStyle: options.forcePathStyle,
        credentials:
          options.accessKeyId && options.secretAccessKey
            ? {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey,
              }
            : undefined,
      });
  }

  private tenantPrefix(tenantId: string): string {
    const safeTenant = tenantId.replace(/[^a-zA-Z0-9-]/g, '_');
    if (!safeTenant) {
      throw new Error('Tenant id is required for storage access');
    }
    return `${safeTenant}/attachments/`;
  }

  private assertTenantKey(tenantId: string, storagePath: string): void {
    const prefix = this.tenantPrefix(tenantId);
    const segments = storagePath.split('/');
    if (
      !storagePath.startsWith(prefix) ||
      segments.some((s) => s === '..' || s === '.' || s === '')
    ) {
      throw new Error('Access denied: storage path outside tenant directory');
    }
  }

  async save(
    tenantId: string,
    fileName: string,
    content: Buffer | Uint8Array,
    mimeType?: string,
  ): Promise<StorageResult> {
    const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${this.tenantPrefix(tenantId)}${randomUUID()}_${safeName}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: content,
        ContentType: mimeType ?? 'application/octet-stream',
        ServerSideEncryption: this.options.serverSideEncryption,
      }),
    );

    return { storagePath: key, fileSize: content.length };
  }

  async read(tenantId: string, storagePath: string): Promise<Buffer> {
    this.assertTenantKey(tenantId, storagePath);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: storagePath }),
    );
    if (!result.Body) {
      throw new Error('Stored object has no content');
    }
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(tenantId: string, storagePath: string): Promise<void> {
    this.assertTenantKey(tenantId, storagePath);
    // S3 DeleteObject is idempotent: deleting a missing key succeeds.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: storagePath }),
    );
  }
}
