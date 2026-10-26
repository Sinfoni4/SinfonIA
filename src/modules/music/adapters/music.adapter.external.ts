import type { MusicAdapter } from './music.adapter.js';

export const externalMusicAdapter: MusicAdapter = {
  createPractice() {
    console.log('🌐 EXTERNAL ADAPTER — createPractice');
    return Promise.resolve({ success: true });
  },

  listPractices() {
    console.log('🌐 EXTERNAL ADAPTER — listPractices');
    return Promise.resolve([]);
  },

  deletePractice() {
    console.log('🌐 EXTERNAL ADAPTER — deletePractice');
    return Promise.resolve({ success: true });
  },

  getContext() {
    console.log('🌐 EXTERNAL ADAPTER — getContext');
    return Promise.resolve({
      recentPractices: [],
      totalPractices: 0,
    });
  },
};
