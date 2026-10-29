import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { afterAll, describe, expect, it } from 'vitest';

import {
  escapeCopyField,
  formatTextArray,
  joinCopyLine,
  parseTextArray,
  splitCopyLine,
  unescapeCopyField,
} from '../scripts/backup/lib/copy-text.js';
import { decryptFromFile, encryptToFile } from '../scripts/backup/lib/crypto-stream.js';
import { RowDigests, ValueSet } from '../scripts/backup/lib/digests.js';
import { createRestoreTransform, parseCopyHeader } from '../scripts/backup/lib/restore-stream.js';
import { Substitution, type ColumnInfo } from '../scripts/backup/lib/substitution.js';

const col = (name: string, dataType: string, udtName = dataType): ColumnInfo => ({
  name,
  dataType,
  udtName,
});
const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '550e8400-e29b-41d4-a716-446655440001';

describe('COPY text format', () => {
  it('round-trips escapes, NULL and arrays', () => {
    const value = 'riga1\nriga2\ttab \\ barra';
    expect(unescapeCopyField(escapeCopyField(value))).toBe(value);
    const line = joinCopyLine(['a', null, value]);
    expect(splitCopyLine(line)).toEqual(['a', null, value]);
    const arr = ['telegram:1', 'con "virgolette"', null];
    expect(parseTextArray(formatTextArray(arr))).toEqual(arr);
    expect(parseTextArray('{a,b}')).toEqual(['a', 'b']);
    expect(parseTextArray('{}')).toEqual([]);
  });

  it('reads COPY headers of pg_restore, quoted table names included', () => {
    expect(parseCopyHeader('COPY public."user" (id, tenant_id, email) FROM stdin;')).toEqual({
      table: 'user',
      columns: ['id', 'tenant_id', 'email'],
    });
    expect(parseCopyHeader('COPY public.practice (id, payload) FROM stdin;')?.table).toBe(
      'practice',
    );
    expect(parseCopyHeader('CREATE TABLE public.practice (')).toBeNull();
  });
});

describe('substitution', () => {
  it('remaps identifiers consistently everywhere they appear', () => {
    const s = new Substitution(30);
    const uuid = col('id', 'uuid');
    const a = s.value('practice', uuid, UUID_A);
    expect(a).not.toBe(UUID_A);
    expect(s.value('audit_log', col('practice_id', 'uuid'), UUID_A)).toBe(a);
    // UUID stored as text (user_tenant.user_id) and inside JSON keep the relation.
    expect(s.value('user_tenant', col('user_id', 'text'), UUID_A)).toBe(a);
    expect(s.json({ practiceId: UUID_A })).toEqual({ practiceId: a });
    expect(s.value('practice', uuid, UUID_B)).not.toBe(a);
  });

  it('replaces contact data with values of the same format, unique and consistent', () => {
    const s = new Substitution(30);
    const email = s.value('user', col('email', 'text'), 'mario.rossi@example.com');
    expect(email).toMatch(/^u[0-9a-f]{10}@example\.invalid$/);
    expect(s.value('user', col('email', 'text'), 'mario.rossi@example.com')).toBe(email);
    expect(s.value('user', col('email', 'text'), 'altro@example.com')).not.toBe(email);
    expect(s.value('user', col('telegram_id', 'text'), '123456789')).toMatch(/^[1-9]\d{9}$/);
    expect(s.value('whatsapp_identity', col('phone_number', 'text'), '393331234567')).toMatch(
      /^39\d{10}$/,
    );
    expect(s.value('tenant', col('webhook_url', 'text'), 'https://real.example/x')).toMatch(
      /^https:\/\/example\.invalid\//,
    );
  });

  it('keeps technical columns and types, replaces every other text, unknown columns included', () => {
    const s = new Substitution(30);
    expect(s.value('practice_attachment', col('mime_type', 'text'), 'application/pdf')).toBe(
      'application/pdf',
    );
    expect(s.value('practice', col('status', 'USER-DEFINED', 'PracticeStatus'), 'CREATED')).toBe(
      'CREATED',
    );
    expect(s.value('outbox_message', col('attempts', 'integer'), '3')).toBe('3');
    expect(s.value('_prisma_migrations', col('migration_name', 'character varying'), 'x')).toBe(
      'x',
    );
    expect(s.value('nuova_tabella', col('nota', 'text'), 'Mario Rossi')).toMatch(/^anon_/);
    expect(s.value('nuova_tabella', col('dato', 'bytea'), '\\x00')).toMatch(/^anon_/);
    expect(s.unclassified.has('nuova_tabella.dato')).toBe(true);
  });

  it('shifts every date by the same whole number of days, keeping time and fractions', () => {
    const s = new Substitution(-40);
    expect(s.value('compliance_deadline', col('due_date', 'date'), '2027-01-31')).toBe(
      '2026-12-22',
    );
    expect(
      s.value(
        'practice',
        col('created_at', 'timestamp with time zone'),
        '2026-10-28 10:15:30.123456+00',
      ),
    ).toBe('2026-09-18 10:15:30.123456+00');
    expect(s.json({ documentDate: '2026-09-30' })).toEqual({ documentDate: '2026-08-21' });
  });

  it('keeps JSON structure and enumerations, renames unknown keys, replaces free text', () => {
    const s = new Substitution(30);
    const out = s.json({
      schemaVersion: 1,
      type: 'music_practice',
      name: 'Mario Rossi',
      metadata: { venue: 'Teatro Verdi' },
      chatId: 123456789,
      total: 122,
    }) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(1);
    expect(out.type).toBe('music_practice');
    expect(out.name).toMatch(/^anon_/);
    expect(out.total).toBe(122);
    expect(out.chatId).not.toBe(123456789);
    const metadata = out.metadata as Record<string, unknown>;
    expect(Object.keys(metadata)[0]).toMatch(/^k_/);
    expect(Object.values(metadata)[0]).toMatch(/^anon_/);
  });
});

describe('row fingerprints', () => {
  it('ignore row order but detect values swapped between rows', () => {
    const key = randomBytes(32);
    const a = new RowDigests(key);
    a.add('t', '1\tMario\t10');
    a.add('t', '2\tLuca\t20');
    const b = new RowDigests(key);
    b.add('t', '2\tLuca\t20');
    b.add('t', '1\tMario\t10');
    const swapped = new RowDigests(key);
    swapped.add('t', '1\tLuca\t10');
    swapped.add('t', '2\tMario\t20');
    expect(a.result().get('t')).toEqual(b.result().get('t'));
    expect(swapped.result().get('t')?.digest).not.toBe(a.result().get('t')?.digest);
  });

  it('find a value without storing it in clear', () => {
    const set = new ValueSet(randomBytes(32));
    set.add('mario.rossi@example.com');
    expect(set.has('mario.rossi@example.com')).toBe(true);
    expect(set.has('altro@example.com')).toBe(false);
  });
});

describe('encrypted stream', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mf0-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips without clear text on disk and rejects a tampered file', async () => {
    const key = randomBytes(32);
    const file = path.join(dir, 'x.enc');
    const clear = 'COPY public.t (a) FROM stdin;\nvalore riservato\n\\.\n';
    await encryptToFile(Readable.from([Buffer.from(clear)]), file, key);
    expect(readFileSync(file).includes(Buffer.from('riservato'))).toBe(false);
    expect(await text(await decryptFromFile(file, key))).toBe(clear);
    await expect(text(await decryptFromFile(file, randomBytes(32)))).rejects.toThrow();
  });
});

describe('restore transform', () => {
  it('fingerprints dump rows before substituting and passes schema statements unchanged', async () => {
    const key = randomBytes(32);
    const columns = new Map([
      ['user', [col('id', 'uuid'), col('email', 'text'), col('role', 'USER-DEFINED', 'UserRole')]],
    ]);
    const substitution = new Substitution(30);
    const dumpDigests = new RowDigests(key);
    const originals = new ValueSet(key);
    const row = `${UUID_A}\tmario@example.com\tADMIN`;
    const script = [
      'CREATE TABLE public."user" ();',
      'COPY public."user" (id, email, role) FROM stdin;',
      row,
      '\\.',
      '',
    ].join('\n');
    const out = await text(
      Readable.from([Buffer.from(script)]).pipe(
        createRestoreTransform({ columns, substitution, dumpDigests, originals }),
      ),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('CREATE TABLE public."user" ();');
    expect(lines[3]).toBe('\\.');
    const [id, email, role] = splitCopyLine(lines[2]);
    expect(id).not.toBe(UUID_A);
    expect(email).toMatch(/@example\.invalid$/);
    expect(role).toBe('ADMIN');
    const reference = new RowDigests(key);
    reference.add('user', row);
    expect(dumpDigests.result().get('user')).toEqual(reference.result().get('user'));
    expect(originals.has('mario@example.com')).toBe(true);
    expect(originals.has('ADMIN')).toBe(false);
  });
});

describe('restore transform on Windows output', () => {
  it('recognizes CRLF lines and refuses a dump truncated inside a data block', async () => {
    const key = randomBytes(32);
    const columns = new Map([['user', [col('id', 'uuid'), col('email', 'text')]]]);
    const make = () =>
      createRestoreTransform({
        columns,
        substitution: new Substitution(30),
        dumpDigests: new RowDigests(key),
        originals: new ValueSet(key),
      });
    const crlf = `COPY public."user" (id, email) FROM stdin;\r\n${UUID_A}\tmario@example.com\r\n\\.\r\n`;
    const out = await text(Readable.from([Buffer.from(crlf)]).pipe(make()));
    expect(out).not.toContain('mario@example.com');
    expect(out).toContain('@example.invalid');
    const truncated = `COPY public."user" (id, email) FROM stdin;\n${UUID_A}\tmario@example.com\n`;
    await expect(text(Readable.from([Buffer.from(truncated)]).pipe(make()))).rejects.toThrow(
      'ended inside the data',
    );
  });
});
