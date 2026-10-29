import { runtimeState } from './runtime.state.js';

export function isRuntimeOperational(): boolean {
  return runtimeState.getMode() === 'HEALTHY';
}

export function getRuntimeAwarenessMessage(): string | null {
  switch (runtimeState.getMode()) {
    case 'DEGRADED':
      return '⚠️ Bot in modalità degradata.\nAlcune funzioni potrebbero non essere disponibili.';
    case 'CIRCUIT_OPEN':
      return '🛠️ Bot in recovery mode.\nSto ristabilendo la connessione al database.\nRiprova tra qualche secondo.';
    default:
      return null;
  }
}
