type ReplyCtx = {
  reply: (text: string) => Promise<unknown>;
};

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error('TELEGRAM_REPLY_TIMEOUT'));
    }, ms);

    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((error: unknown) => {
        clearTimeout(t);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

export async function safeReply(ctx: ReplyCtx, text: string): Promise<void> {
  const maxAttempts = 3;
  const timeoutMs = 5000;
  const backoffBefore: number[] = [0, 500, 1200];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await delay(backoffBefore[attempt - 1] ?? 0);
    }

    console.log(`📡 Telegram send attempt ${attempt}`);

    try {
      await withTimeout(ctx.reply(text), timeoutMs);
      console.log('✅ Telegram message delivered');
      return;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message === 'TELEGRAM_REPLY_TIMEOUT';
      console.warn(`⚠️ Telegram send failed${isTimeout ? ' (timeout)' : ''}`);

      if (attempt < maxAttempts) {
        console.log('🔁 retrying...');
        continue;
      }

      console.error('🛑 Telegram delivery failed after retries');
      return;
    }
  }
}
