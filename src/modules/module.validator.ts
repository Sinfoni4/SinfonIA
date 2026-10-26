import type { DomainModule } from './domain.module.js';

export function validateModule(mod: DomainModule): boolean {
  if (!mod) return false;
  if (typeof mod.name !== 'string') return false;
  if (!Array.isArray(mod.actions)) return false;
  if (typeof mod.resolve !== 'function') return false;
  if (typeof mod.execute !== 'function') return false;
  if (typeof mod.getContext !== 'function') return false;
  return true;
}
