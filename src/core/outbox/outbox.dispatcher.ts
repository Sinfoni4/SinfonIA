import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { errorLabel } from '../../shared/errors.js';

import { DeliveryError } from './outbox.delivery.js';

import type { OutboxDelivery, OutboxEventHandler } from './outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { PrismaClient } from '@prisma/client';

export type OutboxDispatcherOptions = {
  handlers: OutboxEventHandler[];
  maxAttempts?: number;
  batchSize?: number;
  leaseMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => Date;
  random?: () => number;
  log?: { warn: (obj: object, msg: string) => void };
};

export type DispatchStats = {
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
};

// 'lost': the claim expired and another dispatcher took the message over.
type Outcome = 'delivered' | 'retried' | 'deadLettered' | 'lost';

export const NO_HANDLER = 'NO_HANDLER';
export const NO_RECIPIENTS = 'NO_RECIPIENTS';

/**
 * Exponential backoff with ±20% jitter: base · 2^(attempt-1), capped. A receiver-provided
 * retry-after wins when it is longer.
 */
export function computeBackoffMs(
  attempt: number,
  options: { baseMs: number; maxMs: number; random?: () => number; retryAfterMs?: number },
): number {
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + 0.4 * (options.random ?? Math.random)();
  return Math.max(Math.round(exponential * jitter), options.retryAfterMs ?? 0);
}

/**
 * Delivers outbox messages at least once per target. Several dispatchers may run against the same
 * database: claims never overlap, and a dispatcher that dies loses its claim when the lease expires.
 */
export class OutboxDispatcher {
  private readonly repo: OutboxRepository;
  private readonly handlers: Map<string, OutboxEventHandler>;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly log: OutboxDispatcherOptions['log'];

  constructor(prisma: PrismaClient, options: OutboxDispatcherOptions) {
    this.repo = new OutboxRepository(prisma);
    this.handlers = new Map(options.handlers.map((h) => [h.eventType, h]));
    this.maxAttempts = options.maxAttempts ?? 8;
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.log = options.log;
  }

  async dispatchOnce(): Promise<DispatchStats> {
    const claimed = await this.repo.claimDue({
      now: this.now(),
      leaseMs: this.leaseMs,
      limit: this.batchSize,
    });
    const stats: DispatchStats = {
      claimed: claimed.length,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
    };

    for (const message of claimed) {
      const outcome = await this.process(message);
      if (outcome !== 'lost') stats[outcome]++;
    }
    return stats;
  }

  private async process(message: ClaimedOutboxMessage): Promise<Outcome> {
    const handler = this.handlers.get(message.eventType);
    if (!handler) {
      return this.deadLetter(message, `${NO_HANDLER}: ${message.eventType}`);
    }

    let deliveries: OutboxDelivery[];
    try {
      deliveries = await handler.resolveDeliveries(message);
    } catch (err: unknown) {
      return this.retryOrDeadLetter(message, [errorLabel(err)], undefined);
    }
    if (deliveries.length === 0) {
      return this.deadLetter(message, NO_RECIPIENTS);
    }

    const delivered = new Set(message.deliveredTargets);
    const permanent: string[] = [];
    const transient: string[] = [];
    let retryAfterMs: number | undefined;

    for (const delivery of deliveries) {
      if (delivered.has(delivery.target)) continue;
      try {
        await delivery.send();
        if (!(await this.repo.recordDeliveredTarget(message, delivery.target))) {
          return 'lost';
        }
      } catch (err: unknown) {
        // DeliveryError messages are ours (status codes, Bot API descriptions); other errors may
        // carry payload data, so only their label is stored.
        const reason = err instanceof DeliveryError ? err.message : errorLabel(err);
        const label = `${delivery.target}: ${reason}`;
        if (err instanceof DeliveryError && err.permanent) {
          permanent.push(label);
        } else {
          transient.push(label);
          if (err instanceof DeliveryError && err.retryAfterMs !== undefined) {
            retryAfterMs = Math.max(retryAfterMs ?? 0, err.retryAfterMs);
          }
        }
      }
    }

    if (transient.length > 0) {
      return this.retryOrDeadLetter(message, [...permanent, ...transient], retryAfterMs);
    }
    if (permanent.length > 0) {
      return this.deadLetter(message, permanent.join('; '));
    }
    return (await this.repo.completeClaim(message, this.now())) ? 'delivered' : 'lost';
  }

  private async retryOrDeadLetter(
    message: ClaimedOutboxMessage,
    errors: string[],
    retryAfterMs: number | undefined,
  ): Promise<Outcome> {
    const error = errors.join('; ');
    if (message.attempts >= this.maxAttempts) {
      return this.deadLetter(message, `Tentativi esauriti (${message.attempts}): ${error}`);
    }
    const delayMs = computeBackoffMs(message.attempts, {
      baseMs: this.baseBackoffMs,
      maxMs: this.maxBackoffMs,
      random: this.random,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
    const nextAttemptAt = new Date(this.now().getTime() + delayMs);
    return (await this.repo.scheduleRetry(message, nextAttemptAt, error)) ? 'retried' : 'lost';
  }

  private async deadLetter(message: ClaimedOutboxMessage, error: string): Promise<Outcome> {
    this.log?.warn(
      { outboxId: message.id, tenantId: message.tenantId, eventType: message.eventType, error },
      'Outbox message moved to dead letter',
    );
    return (await this.repo.moveToDeadLetter(message, error)) ? 'deadLettered' : 'lost';
  }
}
