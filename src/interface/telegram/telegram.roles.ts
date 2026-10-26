export type UserRole = 'ASSOCIATO' | 'OPERATORE';

// In-memory role store (per bot process). Deterministic for a given runtime.
const roleStore = new Map<string, UserRole>();

export function getUserRole(userId: string): UserRole {
  // Demo logic: first user = operatore
  // replace with real auth later
  if (userId === '123456') return 'OPERATORE';

  return roleStore.get(userId) ?? 'ASSOCIATO';
}

export function setUserRole(userId: string, role: UserRole) {
  roleStore.set(userId, role);
}

export function getRoleDebugState() {
  return {
    trackedRoles: roleStore.size,
  };
}

export function resetRoleMemory() {
  roleStore.clear();
}
