import { NotFoundError } from '../../data/errors/errors.js';
import { PracticeRepository } from '../../data/repositories/practice.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { requireDatabase } from '../../runtime/runtime.guard.js';
import { ConcurrencyError } from '../errors/concurrency.errors.js';
import { InvalidStateTransitionError } from '../errors/workflow.errors.js';

import { canTransition } from './state-machine.js';

import type { TransactionHost } from '../../data/transactions/transaction.js';
import type { PracticeDTO } from '../../data/types/domain.js';
import type { PrismaTx } from '../../data/types/prisma.js';
import type { PracticeState, TransitionInput } from '../types/workflow.types.js';

export function validateTransition(currentState: PracticeState, nextState: PracticeState): void {
  if (!canTransition(currentState, nextState)) {
    throw new InvalidStateTransitionError(currentState, nextState);
  }
}

// Deterministic workflow service: state machine + transactional persistence + audit.
export class PracticeWorkflow {
  constructor(private readonly txHost: TransactionHost) {}

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
