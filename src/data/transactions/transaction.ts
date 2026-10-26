import type { PrismaTx } from '../types/prisma.js';

// Transaction wrapper that passes an explicit transaction context into repositories.
// This avoids hidden ambient state and keeps services stateless.
export type TransactionHost = {
  $transaction: <T>(fn: (tx: PrismaTx) => Promise<T>) => Promise<T>;
};

export async function withTransaction<T>(
  prisma: TransactionHost,
  fn: (tx: PrismaTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx));
}
