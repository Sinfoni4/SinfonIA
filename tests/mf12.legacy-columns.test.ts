/**
 * MF12 step 1 (docs/FASE1_CORE_E_MODULI.md §7): the columns of the old model on `user`
 * (`tenant_id`, `role`, `telegram_id`) are read and written only where listed here, with the
 * reason, until the contraction migration removes them. Organization and role come from
 * `membership`, chat links from `channel_identity`. A new use makes this test fail.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const relative = (file: string) => path.relative(ROOT, file).replace(/\\/g, '/');

/** The argument of a call starting at `open` (the index of its `(`), brackets balanced. */
function callArgument(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

const USER_CALL =
  /\.user\.(?:findFirst|findFirstOrThrow|findMany|findUnique|findUniqueOrThrow|count|update|updateMany|create|createMany|upsert|groupBy|aggregate)\(/g;
// `key:` and the shorthand `key,` / `key }`.
const LEGACY_KEY = /\b(tenantId|role|telegramId)\b(?=\s*[:,}])/g;

/** Every use of a legacy column in a Prisma call on `user`, as `file: column`. */
function legacyUses(): string[] {
  const uses: string[] = [];
  for (const dir of ['src', 'scripts']) {
    for (const file of filesUnder(path.join(ROOT, dir))) {
      const source = readFileSync(file, 'utf8');
      for (const call of source.matchAll(USER_CALL)) {
        const argument = callArgument(source, call.index + call[0].length - 1);
        for (const key of argument.matchAll(LEGACY_KEY)) uses.push(`${relative(file)}: ${key[1]}`);
      }
    }
  }
  return uses.sort();
}

describe('MF12: columns of the old model on user', () => {
  it('are not used any more (contraction, step 5)', () => {
    expect(legacyUses()).toEqual([]);
  });

  it('never touches the Telegram column in SQL: chat links live in channel_identity', () => {
    const allowed = new Set<string>();
    for (const dir of ['src', 'scripts']) {
      for (const file of filesUnder(path.join(ROOT, dir))) {
        if (allowed.has(relative(file))) continue;
        expect(/telegram_id/.test(readFileSync(file, 'utf8')), relative(file)).toBe(false);
      }
    }
  });
});
