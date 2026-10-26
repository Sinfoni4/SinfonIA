import { externalMusicAdapter } from './adapters/music.adapter.external.js';
import { internalMusicAdapter } from './adapters/music.adapter.internal.js';

import type { MusicAdapter } from './adapters/music.adapter.js';

export function getMusicAdapter(integrationType: 'none' | 'external' = 'none'): MusicAdapter {
  if (integrationType === 'external') {
    return externalMusicAdapter;
  }

  return internalMusicAdapter;
}
