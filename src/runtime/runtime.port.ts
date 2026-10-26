import type { Server } from 'http';

const MAX_RETRIES = process.env.NODE_ENV === 'production' ? 2 : 10;
const BASE_DELAY_MS = 250;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_MAX_TOTAL_WAIT_MS = 15000;

export async function listenWithRetry(server: Server, port: number): Promise<void> {
  let attempt = 0;
  const startTime = Date.now();

  while (attempt <= MAX_RETRIES) {
    console.log('PORT CHECK — attempting bind', port);
    server.removeAllListeners('error');
    server.removeAllListeners('listening');

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          console.log('PORT CHECK — error event', (error as { code?: string }).code);
          server.off('error', onError);
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          server.off('listening', onListening);
          console.log('PORT CHECK — listening event fired');
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        console.log('PORT CHECK — listen() called');
        server.listen(port, '0.0.0.0');
      });

      console.log(`🌐 HTTP server bound on port ${port}`);
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'EADDRINUSE') {
        throw err;
      }

      attempt++;

      if (attempt > MAX_RETRIES) {
        console.error('💥 Port still busy after retries.');
        if (IS_PRODUCTION) {
          throw err;
        }

        // Dev-only: keep waiting instead of crashing on hot-reload races.
        attempt = 0;
      }

      const delay = BASE_DELAY_MS * Math.max(1, attempt);
      console.warn(`⏳ Port ${port} busy — retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);

      const elapsed = Date.now() - startTime;
      if (!IS_PRODUCTION && elapsed > DEV_MAX_TOTAL_WAIT_MS) {
        console.warn('⚠️ HTTP bind postponed — runtime continues without HTTP');
        setTimeout(() => {
          void listenWithRetry(server, port).catch(() => {});
        }, 3000);
        return;
      }

      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
