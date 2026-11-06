/**
 * Draws the icons of the installable dashboard (web/public): a rounded square in the brand colour
 * with a white ring and dot, at 192 and 512 px, plus a maskable 512 px version with a safe margin.
 * No dependency: PNG written by hand with zlib. Run again after changing the design:
 * `npx tsx scripts/web/make-icons.ts`.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const BRAND = [0x1f, 0x4e, 0x79] as const; // deep blue
const WHITE = [0xff, 0xff, 0xff] as const;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** RGBA pixels, antialiased by 4x4 supersampling. */
function draw(size: number, maskable: boolean): Buffer {
  const rows: Buffer[] = [];
  const corner = maskable ? 0 : size * 0.22;
  const scale = maskable ? 0.62 : 0.78; // the ring stays inside the maskable safe zone
  const c = size / 2;
  const outer = (size / 2) * scale * 0.82;
  const inner = outer * 0.62;
  const dot = outer * 0.24;
  const inside = (x: number, y: number): 'bg' | 'fg' | 'none' => {
    // Rounded square background.
    const dx = Math.max(Math.abs(x - c) - (c - corner), 0);
    const dy = Math.max(Math.abs(y - c) - (c - corner), 0);
    if (corner > 0 && dx * dx + dy * dy > corner * corner) return 'none';
    const r = Math.hypot(x - c, y - c);
    if ((r <= outer && r >= inner) || r <= dot) return 'fg';
    return 'bg';
  };
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let fg = 0;
      let bg = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const hit = inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
          if (hit === 'fg') fg++;
          else if (hit === 'bg') bg++;
        }
      }
      const alpha = (fg + bg) / 16;
      const mix = fg + bg === 0 ? 0 : fg / (fg + bg);
      const o = 1 + x * 4;
      for (let i = 0; i < 3; i++) row[o + i] = Math.round(BRAND[i]! * (1 - mix) + WHITE[i]! * mix);
      row[o + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.resolve('web/public');
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
] as const) {
  writeFileSync(path.join(out, name), draw(size, maskable));
  console.log(`web/public/${name}`);
}
