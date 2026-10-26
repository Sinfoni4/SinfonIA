type Memory = {
  lastPracticeId?: string;
};

const memoryStore = new Map<string, Memory>();
const seenUsers = new Set<string>();

export function setLastPractice(userId: string, practiceId: string) {
  const current = memoryStore.get(userId) ?? {};
  memoryStore.set(userId, { ...current, lastPracticeId: practiceId });
}

export function getLastPractice(userId: string): string | null {
  return memoryStore.get(userId)?.lastPracticeId ?? null;
}

export function hasSeenUser(userId: string): boolean {
  return seenUsers.has(userId);
}

export function markUserSeen(userId: string) {
  seenUsers.add(userId);
}

export function getTelegramMemoryState() {
  return {
    seenUsersCount: seenUsers.size,
    memoryEntries: memoryStore.size,
  };
}

export function resetTelegramMemory() {
  memoryStore.clear();
  seenUsers.clear();
}
