import { getTenantByUser } from '../core/tenant/tenant.store.js';

import { moduleRegistry } from './module.registry.js';

import type { DomainCommand } from './domain.module.js';
import type { DomainModule } from './domain.module.js';

export interface ModuleRoutingResult {
  module: string;
  command: DomainCommand;
  instance: DomainModule;
}

export function routeModules(input: string): ModuleRoutingResult[] {
  const matches: ModuleRoutingResult[] = [];

  for (const mod of moduleRegistry) {
    try {
      const result = mod.resolve(input);
      if (result) {
        matches.push({
          module: mod.name,
          command: result,
          instance: mod,
        });
      }
    } catch (err: unknown) {
      console.error(`❌ MODULE RESOLVE ERROR — ${mod.name}`, err);
    }
  }

  return matches;
}

export function routeModulesForTenant(input: string, userId: string): ModuleRoutingResult[] {
  const tenant = getTenantByUser(userId);
  const matches: ModuleRoutingResult[] = [];

  for (const mod of moduleRegistry) {
    if (mod.name !== tenant.module) continue;

    try {
      const result = mod.resolve(input);
      if (result) {
        matches.push({
          module: mod.name,
          command: result,
          instance: mod,
        });
      }
    } catch (err: unknown) {
      console.error(`❌ MODULE RESOLVE ERROR — ${mod.name}`, err);
    }
  }

  return matches;
}
