import net from 'net';

export async function tcpDatabaseCheck(): Promise<boolean> {
  console.log('🧪 TCP CHECK start');

  const host = '127.0.0.1';
  const port = 5432;
  const timeoutMs = 1500;

  const startedAt = Date.now();

  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      const latencyMs = Date.now() - startedAt;

      if (ok) console.log('🟢 TCP CONNECT OK');
      else console.log('🔴 TCP CONNECT FAIL');

      console.log(`⏱ TCP LATENCY ${latencyMs} ms`);
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs, () => finish(false));

    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));

    socket.connect(port, host);
  });
}
