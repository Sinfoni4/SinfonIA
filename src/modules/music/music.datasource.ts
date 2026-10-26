import { getTenantById } from '../../core/tenant/tenant.store.js';

import { externalMusicAdapter } from './adapters/music.adapter.external.js';
import { internalMusicAdapter } from './adapters/music.adapter.internal.js';

import type { MusicAdapter } from './adapters/music.adapter.js';

export function getMusicAdapter(tenantId: string): MusicAdapter {
  const tenant = getTenantById(tenantId);
  const integration = tenant.integration?.type ?? 'none';

  if (integration === 'external') {
    console.log(`🔌 DATA SOURCE — tenant=${tenantId} mode=external`);
    return externalMusicAdapter;
  }

  console.log(`💾 DATA SOURCE — tenant=${tenantId} mode=internal`);
  return internalMusicAdapter;
}
