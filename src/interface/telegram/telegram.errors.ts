import { runtimeState } from '../../runtime/runtime.state.js';

export function mapTelegramErrorToMessage(err: unknown): string {
  if (runtimeState.getMode() === 'CIRCUIT_OPEN') {
    return '⚠️ Il sistema sta recuperando la connessione al database.\nRiprova tra qualche secondo.';
  }

  if ((err as { code?: string } | null)?.code === 'DATABASE_OFFLINE') {
    return '⚠️ Il database non è disponibile al momento.\nRiprova tra qualche istante.';
  }

  const msg = err instanceof Error ? err.message : '';

  // Prisma connection failure (code P1001)
  if (msg.includes('P1001') || msg.includes("Can't reach database")) {
    if (process.env.NODE_ENV === 'development') {
      console.log('🧯 DB OFFLINE fallback triggered');
    }
    return '⚠️ Il database non è disponibile al momento.\nRiprova tra qualche minuto.';
  }

  if (msg.includes('Ambiguous')) {
    return '⚠️ Ho trovato più pratiche simili.\nPuoi indicarmi meglio quale intendi?';
  }

  if (msg.includes('PERMISSION_DENIED')) {
    return 'ℹ️ Questa operazione richiede un operatore o un amministratore della tua cooperativa.';
  }

  if (msg.includes('VALIDATION')) {
    return '❌ Questa operazione non è possibile in questo momento.';
  }

  return '⚠️ Errore temporaneo del sistema.';
}

export const mapTelegramError = mapTelegramErrorToMessage;
