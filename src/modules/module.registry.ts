import { demoModule } from './demo/demo.module.js';
import { validateModule } from './module.validator.js';
import { musicModule } from './music/music.module.js';

import type { DomainModule } from './domain.module.js';

const rawModules: DomainModule[] = [musicModule, demoModule];

export const moduleRegistry: DomainModule[] = rawModules.filter((mod) => {
  const valid = validateModule(mod);
  if (!valid) {
    console.error(`❌ MODULE INVALID — ${mod?.name ?? 'unknown'}`);
    return false;
  }

  console.log(`✅ MODULE LOADED — ${mod.name}`);
  return true;
});
