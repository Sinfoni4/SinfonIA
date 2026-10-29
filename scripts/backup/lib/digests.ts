import { createHmac } from 'node:crypto';

/**
 * Order-independent fingerprint of the rows of each table: the sum, modulo 2^256, of an HMAC of
 * every row. Two sources give the same fingerprint only if they contain the same rows, each with
 * all its values (values swapped between rows change it). Constant memory; the key is ephemeral,
 * so the fingerprints cannot be checked against guessed values once the run is over.
 */

const MOD = 1n << 256n;

export type TableFingerprint = { rows: number; digest: string };

export class RowDigests {
  private readonly tables = new Map<string, { rows: number; sum: bigint }>();

  constructor(private readonly key: Buffer) {}

  add(table: string, line: string): void {
    const h = createHmac('sha256', this.key)
      .update(table)
      .update('\u0000')
      .update(line)
      .digest('hex');
    const entry = this.tables.get(table) ?? { rows: 0, sum: 0n };
    entry.rows++;
    entry.sum = (entry.sum + BigInt(`0x${h}`)) % MOD;
    this.tables.set(table, entry);
  }

  /** Registers a table even when it has no rows. */
  touch(table: string): void {
    if (!this.tables.has(table)) this.tables.set(table, { rows: 0, sum: 0n });
  }

  result(): Map<string, TableFingerprint> {
    return new Map(
      [...this.tables].map(([table, { rows, sum }]) => [
        table,
        { rows, digest: sum.toString(16).padStart(64, '0') },
      ]),
    );
  }
}

/** HMAC of single values, to check that none of them reaches the copy. */
export class ValueSet {
  private readonly hashes = new Set<string>();

  constructor(private readonly key: Buffer) {}

  private hash(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('hex');
  }

  add(value: string): void {
    this.hashes.add(this.hash(value));
  }

  has(value: string): boolean {
    return this.hashes.has(this.hash(value));
  }

  get size(): number {
    return this.hashes.size;
  }
}
