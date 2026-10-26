import { requireDatabase } from '../../runtime/runtime.guard.js';

import type { PrismaLike } from '../../data/types/prisma.js';
import type { InMemoryPracticeRepository } from '../../domain/practice.repository.js';

export type PracticeContext = {
  practices: Array<{
    id: string;
    name?: string | null;
    status: 'CREATED' | 'VALIDATED' | 'COMPLETED' | 'SUBMITTED' | 'FAILED';
    type: string;
    summary: string;
  }>;
};

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

function readNameFromPayload(payload: unknown): string | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const maybeName = rec.name;
  return typeof maybeName === 'string' && maybeName.trim().length > 0 ? maybeName.trim() : null;
}

function hasMarker(payload: unknown, marker: string): boolean {
  const rec = asRecord(payload);
  if (!rec) return false;
  const markerLower = marker.toLowerCase();

  for (const [key, value] of Object.entries(rec)) {
    if (key.toLowerCase().includes(markerLower)) return true;
    if (typeof value === 'string' && value.toLowerCase().includes(markerLower)) return true;
  }
  return false;
}

function deriveType(payload: unknown): string {
  const tags: string[] = [];
  if (hasMarker(payload, 'onboarding')) tags.push('onboarding');
  if (hasMarker(payload, 'customer')) tags.push('cliente');
  if (hasMarker(payload, 'invoice')) tags.push('fattura');
  if (tags.length === 0) return 'generic practice';
  return tags.join(' ');
}

function deriveSummary(name: string | null, type: string): string {
  if (name && type !== 'generic practice') {
    return `pratica ${type} ${name}`;
  }
  if (name) {
    return `pratica creazione cliente ${name}`;
  }
  if (type !== 'generic practice') {
    return `pratica ${type}`;
  }
  return 'generic practice';
}

export class ContextService {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly artistPracticeRepo?: InMemoryPracticeRepository,
  ) {}

  async getPracticeContext(tenantId: string, userId?: string | null): Promise<PracticeContext> {
    requireDatabase();

    const rows = await this.prisma.practice.findMany({
      where: {
        tenantId,
        ...(userId ? { userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        payload: true,
      },
    });

    const artistPractices = this.artistPracticeRepo?.findAll(tenantId) ?? [];

    return {
      practices: [
        ...artistPractices.map((p) => ({
          id: p.id,
          name: p.artistName,
          status: p.status,
          type: 'artist practice',
          summary: `pratica artista ${p.artistName}`,
        })),
        ...rows.map((row) => {
          const name = readNameFromPayload(row.payload);
          const type = deriveType(row.payload);
          return {
            id: row.id,
            name,
            status: row.status,
            type,
            summary: deriveSummary(name, type),
          };
        }),
      ],
    };
  }
}
