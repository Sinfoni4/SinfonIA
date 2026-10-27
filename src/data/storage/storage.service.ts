import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface StorageResult {
  storagePath: string;
  fileSize: number;
}

export interface StorageService {
  save(
    tenantId: string,
    fileName: string,
    content: Buffer | Uint8Array,
    mimeType?: string,
  ): Promise<StorageResult>;
  read(tenantId: string, storagePath: string): Promise<Buffer>;
  delete(tenantId: string, storagePath: string): Promise<void>;
}

export class LocalStorageService implements StorageService {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), '.runtime', 'storage');
  }

  private sanitizeFileName(fileName: string): string {
    return path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private resolveTenantPath(tenantId: string, storagePath?: string): string {
    const safeTenant = this.sanitizeFileName(tenantId);
    const tenantDir = path.resolve(this.baseDir, safeTenant);

    if (!storagePath) {
      return tenantDir;
    }

    const resolved = path.resolve(this.baseDir, storagePath);
    // Security check: ensure path does not escape the tenant directory
    if (!resolved.startsWith(tenantDir)) {
      throw new Error('Access denied: storage path outside tenant directory');
    }
    return resolved;
  }

  async save(
    tenantId: string,
    fileName: string,
    content: Buffer | Uint8Array,
  ): Promise<StorageResult> {
    const tenantDir = this.resolveTenantPath(tenantId);
    await fs.mkdir(tenantDir, { recursive: true });

    const safeName = this.sanitizeFileName(fileName);
    const uniqueName = `${randomUUID()}_${safeName}`;
    const fullPath = path.join(tenantDir, uniqueName);

    await fs.writeFile(fullPath, content);
    const relativePath = path.relative(this.baseDir, fullPath).replace(/\\/g, '/');

    return {
      storagePath: relativePath,
      fileSize: content.length,
    };
  }

  async read(tenantId: string, storagePath: string): Promise<Buffer> {
    const fullPath = this.resolveTenantPath(tenantId, storagePath);
    return fs.readFile(fullPath);
  }

  async delete(tenantId: string, storagePath: string): Promise<void> {
    const fullPath = this.resolveTenantPath(tenantId, storagePath);
    try {
      await fs.unlink(fullPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

export const defaultStorageService = new LocalStorageService();
