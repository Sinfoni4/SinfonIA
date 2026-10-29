import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import type { Readable } from 'node:stream';

/**
 * AES-256-GCM file encryption as a stream: the clear text never touches the disk.
 * File layout: 12-byte IV, ciphertext, 16-byte authentication tag.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

export async function encryptToFile(source: Readable, path: string, key: Buffer): Promise<number> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(path, { flags: 'wx' });
  out.write(iv);
  let bytes = 0;
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  // The cipher is flushed (final) when the source ends; the tag is appended afterwards.
  await pipeline(source, cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(cipher.getAuthTag(), () => resolve());
  });
  return bytes;
}

/** Clear-text stream of an encrypted file; fails at the end if the file was altered. */
export async function decryptFromFile(path: string, key: Buffer): Promise<Readable> {
  const { size } = await stat(path);
  if (size < IV_BYTES + TAG_BYTES) throw new Error('Encrypted file too short');
  const handle = await open(path, 'r');
  const iv = Buffer.alloc(IV_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(iv, 0, IV_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const body = createReadStream(path, { start: IV_BYTES, end: size - TAG_BYTES - 1 });
  return body.pipe(decipher);
}
