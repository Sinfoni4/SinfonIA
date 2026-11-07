import { NotFoundError } from '../../data/errors/errors.js';
import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { PracticeRepository } from '../../data/repositories/practice.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { requireDatabase } from '../../runtime/runtime.guard.js';
import { ConcurrencyError } from '../errors/concurrency.errors.js';
import { InvalidStateTransitionError } from '../errors/workflow.errors.js';
import { PRACTICE_STATUS_CHANGED } from '../outbox/practice-status.handler.js';
import { notifyNewHolder, practiceRecipient, requireHolder } from '../practice/practice-holder.js';
import { buildPracticePayload } from '../practice/practice.payload.js';

import { canTransition } from './state-machine.js';

import type { TransactionHost } from '../../data/transactions/transaction.js';
import type { PracticeDTO } from '../../data/types/domain.js';
import type { PrismaTx } from '../../data/types/prisma.js';
import type {
  CreatePracticeInput,
  PracticeState,
  TransitionInput,
} from '../types/workflow.types.js';

export function validateTransition(currentState: PracticeState, nextState: PracticeState): void {
  if (!canTransition(currentState, nextState)) {
    throw new InvalidStateTransitionError(currentState, nextState);
  }
}

// Deterministic workflow service: state machine + transactional persistence + audit.
export class PracticeWorkflow {
  constructor(private readonly txHost: TransactionHost) {}

  async createPractice(input: CreatePracticeInput): Promise<PracticeDTO> {
    requireDatabase();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new NotFoundError('Practice name is required');
    }

    return withTransaction(this.txHost, async (tx: PrismaTx) => {
      const repo = new PracticeRepository(tx);
      const audit = new AuditService(tx);

      const kind = input.kind ?? 'generic';
      // AGX-03: opened for someone else; for the creator themselves there is no holder.
      const holderUserId =
        input.holderUserId && input.holderUserId !== input.userId ? input.holderUserId : null;
      if (holderUserId) await requireHolder(tx, input.tenantId, holderUserId);
      const created = await repo.createPractice(input.tenantId, {
        userId: input.userId,
        holderUserId,
        payload: buildPracticePayload(kind, name, input.metadata),
      });

      await audit.logEvent({
        tenantId: input.tenantId,
        userId: input.actorUserId ?? input.userId,
        eventType: 'PRACTICE_CREATED',
        payload: {
          practiceId: created.id,
          ...(holderUserId ? { targetUserId: holderUserId } : {}),
        },
      });
      if (holderUserId) {
        await notifyNewHolder(tx, {
          tenantId: input.tenantId,
          practiceId: created.id,
          holderUserId,
          actorUserId: input.actorUserId ?? input.userId,
        });
      }

      return created;
    });
  }

  async transitionPractice(input: TransitionInput): Promise<PracticeDTO> {
    requireDatabase();

    return withTransaction(this.txHost, async (tx: PrismaTx) => {
      const repo = new PracticeRepository(tx);
      const audit = new AuditService(tx);

      const practice = await repo.getPracticeById(input.tenantId, input.practiceId);
      const from = practice.status;
      const to = input.nextState;

      validateTransition(from, to);

      // Atomic update + audit append-only
      const updated = await repo
        .updatePracticeStatusWithVersion({
          tenantId: input.tenantId,
          id: input.practiceId,
          nextStatus: to,
          currentVersion: practice.version,
        })
        .catch((err: unknown) => {
          // Do not retry automatically; caller decides.
          if (err instanceof NotFoundError) {
            throw new ConcurrencyError('Practice was modified concurrently');
          }
          throw err;
        });

      await audit.logEvent({
        tenantId: input.tenantId,
        userId: input.userId,
        eventType: 'PRACTICE_STATE_CHANGED',
        payload: {
          practiceId: input.practiceId,
          from,
          to,
        },
      });

      // A3: the owner hears in chat when someone else moves their practice, in the same
      // transaction, so a rolled-back change sends nothing. AGX-03: the holder, when there is one.
      const recipient = practiceRecipient(practice);
      if (recipient !== input.userId) {
        await new OutboxRepository(tx).createMessage({
          tenantId: input.tenantId,
          eventType: PRACTICE_STATUS_CHANGED,
          payload: { practiceId: input.practiceId, userId: recipient, from, to },
        });
      }

      return updated;
    }).catch((err: unknown) => {
      // Preserve semantic errors.
      if (err instanceof ConcurrencyError) throw err;
      if (err instanceof InvalidStateTransitionError) throw err;
      if (err instanceof NotFoundError) throw err;
      throw err;
    });
  }
}
