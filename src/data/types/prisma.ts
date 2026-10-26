import type { Prisma, PrismaClient } from '@prisma/client';

// Prisma is infrastructure. Repositories accept either a root client or a transaction client.
export type PrismaTx = Prisma.TransactionClient;
export type PrismaLike = PrismaClient | PrismaTx;
