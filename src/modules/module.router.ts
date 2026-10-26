import { moduleRegistry } from './module.registry.js';

import type { DomainCommand } from './domain.module.js';
import type { DomainModule } from './domain.module.js';

export interface ModuleRoutingResult {
  module: string;
  command: DomainCommand;
  instance: DomainModule;
}

export function routeModulesForTenant(input: string, tenantModule: string): ModuleRoutingResult[] {
  const matches: ModuleRoutingResult[] = [];

  for (const mod of moduleRegistry) {
    if (mod.name !== tenantModule) continue;

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
      console.error(
        `❌ MODULE RESOLVE ERROR — ${mod.name}`,
        err instanceof Error ? err.name : 'unknown error',
      );
    }
  }

  return matches;
}
