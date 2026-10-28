import { S3StorageService } from './s3.storage.js';
import { LocalStorageService, type StorageService } from './storage.service.js';

import type { AppConfig } from '../../config/config.js';

export type StorageConfig = Pick<
  AppConfig,
  | 'STORAGE_DRIVER'
  | 'STORAGE_LOCAL_DIR'
  | 'S3_BUCKET'
  | 'S3_REGION'
  | 'S3_ENDPOINT'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_SERVER_SIDE_ENCRYPTION'
>;

/** Builds the attachment storage selected by STORAGE_DRIVER (local filesystem or S3/MinIO). */
export function createStorageService(config: StorageConfig): StorageService {
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET) {
      throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    }
    return new S3StorageService({
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      serverSideEncryption: config.S3_SERVER_SIDE_ENCRYPTION,
    });
  }
  return new LocalStorageService(config.STORAGE_LOCAL_DIR);
}
