import type { UserRole } from './telegram.roles.js';

export function checkPermission(role: UserRole, action: string): boolean {
  if (role === 'OPERATORE') return true;

  if (role === 'ASSOCIATO') {
    return action === 'create_practice';
  }

  return false;
}
