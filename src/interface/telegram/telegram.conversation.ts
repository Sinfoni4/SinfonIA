type PendingAction =
  | {
      type: 'AMBIGUITY_SELECTION';
      options: string[];
    }
  | {
      type: 'REQUEST_OPERATOR';
      payload: {
        action: string;
        practiceId?: string | null;
      };
    };

// In-memory pending store (per bot process).
const conversationStore = new Map<string, PendingAction>();

export function setPending(userId: string, action: PendingAction) {
  conversationStore.set(userId, action);
}

export function getPending(userId: string): PendingAction | null {
  return conversationStore.get(userId) ?? null;
}

export function clearPending(userId: string) {
  conversationStore.delete(userId);
}

export function getConversationDebugState() {
  return {
    activeConversations: conversationStore.size,
  };
}

export function resetConversationMemory() {
  conversationStore.clear();
}
