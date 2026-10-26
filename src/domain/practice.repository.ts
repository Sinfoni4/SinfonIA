import { randomUUID } from 'node:crypto';

import type { ArtistPracticeStatus, Practice } from './practice.entity.js';

const ALLOWED: Readonly<Record<ArtistPracticeStatus, ReadonlyArray<ArtistPracticeStatus>>> = {
  CREATED: ['VALIDATED'],
  VALIDATED: ['COMPLETED'],
  COMPLETED: [],
};

export class InMemoryPracticeRepository {
  private practices: Practice[] = [];

  create(artistName: string): Practice {
    const now = new Date();
    const practice: Practice = {
      id: randomUUID(),
      artistName,
      status: 'CREATED',
      createdAt: now,
      updatedAt: now,
    };
    this.practices.unshift(practice);
    return practice;
  }

  findAll(): Practice[] {
    return [...this.practices];
  }

  findById(id: string): Practice | null {
    return this.practices.find((p) => p.id === id) ?? null;
  }

  findByArtistName(name: string): Practice[] {
    const needle = name.trim().toLowerCase();
    return this.practices.filter((p) => p.artistName.trim().toLowerCase() === needle);
  }

  updateStatus(id: string, newStatus: ArtistPracticeStatus): Practice {
    const idx = this.practices.findIndex((p) => p.id === id);
    if (idx === -1) {
      throw new Error(`Practice not found: ${id}`);
    }
    const current = this.practices[idx];
    const allowed = ALLOWED[current.status] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new Error(`Invalid transition: ${current.status}->${newStatus}`);
    }
    const updated: Practice = {
      ...current,
      status: newStatus,
      updatedAt: new Date(),
    };
    this.practices[idx] = updated;
    return updated;
  }

  /** Test/demo helper. */
  clear(): void {
    this.practices = [];
  }
}
