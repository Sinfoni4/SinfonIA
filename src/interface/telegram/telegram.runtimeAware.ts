import {
  getRuntimeAwarenessMessage,
  isRuntimeOperational,
} from '../../runtime/runtime.awareness.js';

import { safeReply } from './telegram.transport.js';

type RuntimeReplyCtx = {
  reply: (text: string) => Promise<unknown>;
};

export async function runtimeAwareExecute(
  ctx: RuntimeReplyCtx,
  handler: () => Promise<void>,
): Promise<void> {
  if (!isRuntimeOperational()) {
    const message = getRuntimeAwarenessMessage();

    if (message) {
      await safeReply(ctx, message);
    }

    return;
  }

  await handler();
}
