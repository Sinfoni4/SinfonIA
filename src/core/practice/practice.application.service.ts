import { NotFoundError } from '../../data/errors/errors.js';
import { PracticeRepository } from '../../data/repositories/practice.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { requireDatabase } from '../../runtime/runtime.guard.js';
import { PracticeWorkflow } from '../workflow/practice.workflow.js';

import { escapeCsvField, exportFilterTitle, isWithinExportFilter } from './practice.export.js';
import { readPracticePayload } from './practice.payload.js';

import type { PracticeCommand } from './practice.commands.js';
import type { PracticeExportFilter } from './practice.export.js';
import type { PracticeKind, PracticePayloadKind } from './practice.payload.js';
import type { PracticeDTO } from '../../data/types/domain.js';
import type { PracticeState } from '../types/workflow.types.js';
import type { PrismaClient } from '@prisma/client';

export type PracticeActor = {
  tenantId: string;
  userId: string;
};

export type PracticeView = {
  id: string;
  tenantId: string;
  userId: string;
  status: PracticeState;
  version: number;
  name: string;
  kind: PracticePayloadKind;
  typeLabel: string;
  summary: string;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type PracticeExportResult = {
  filter: PracticeExportFilter;
  title: string;
  csv: string;
  practices: PracticeView[];
};

export type PracticeCommandResult =
  | { type: 'created'; practice: PracticeView }
  | { type: 'list'; practices: PracticeView[] }
  | { type: 'status'; practice: PracticeView }
  | { type: 'deleted'; practice: PracticeView }
  | { type: 'export'; result: PracticeExportResult; send: boolean }
  | { type: 'not_found'; name: string };

function toView(dto: PracticeDTO): PracticeView {
  const payload = readPracticePayload(dto.payload);
  const name = payload.name ?? `Pratica ${dto.id.slice(0, 8)}`;

  return {
    id: dto.id,
    tenantId: dto.tenantId,
    userId: dto.userId,
    status: dto.status,
    version: dto.version,
    name,
    kind: payload.kind,
    typeLabel: payload.typeLabel,
    summary: payload.name ? payload.summary : `${payload.typeLabel} ${name}`,
    payload: dto.payload,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

/**
 * Canonical application service for every practice use case.
 *
 * HTTP, Telegram and the scheduler are transport adapters: they must not
 * create or transition practices by themselves. This service is the only
 * write path and always uses a real persisted user.
 */
export class PracticeApplicationService {
  private readonly workflow: PracticeWorkflow;
  private readonly repository: PracticeRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.workflow = new PracticeWorkflow(prisma);
    this.repository = new PracticeRepository(prisma);
  }

  async createPractice(input: {
    tenantId: string;
    userId: string;
    name: string;
    kind: PracticeKind;
  }): Promise<PracticeView> {
    const name = input.name.trim();
    if (!name) throw new NotFoundError('Practice name is required');

    const dto = await this.workflow.createPractice({
      tenantId: input.tenantId,
      userId: input.userId,
      name,
      kind: input.kind,
    });
    return toView(dto);
  }

  async transitionPractice(input: {
    tenantId: string;
    userId: string;
    practiceId: string;
    nextState: PracticeState;
  }): Promise<PracticeView> {
    const dto = await this.workflow.transitionPractice({
      tenantId: input.tenantId,
      userId: input.userId,
      practiceId: input.practiceId,
      nextState: input.nextState,
    });
    return toView(dto);
  }

  async listPractices(input: {
    tenantId: string;
    userId?: string;
    status?: PracticeState;
    limit?: number;
  }): Promise<PracticeView[]> {
    requireDatabase();

    const rows = await this.repository.listPractices(input.tenantId, {
      userId: input.userId,
      status: input.status,
    });
    const views = rows.map(toView);

    return typeof input.limit === 'number' && input.limit > 0 ? views.slice(0, input.limit) : views;
  }

  async getPractice(input: {
    tenantId: string;
    practiceId: string;
    userId?: string;
  }): Promise<PracticeView> {
    requireDatabase();

    const dto = await this.repository.getPracticeById(input.tenantId, input.practiceId);
    if (input.userId && dto.userId !== input.userId) {
      throw new NotFoundError('Practice not found');
    }
    return toView(dto);
  }

  async deletePractice(input: {
    tenantId: string;
    practiceId: string;
    userId?: string;
  }): Promise<PracticeView> {
    requireDatabase();

    return withTransaction(this.prisma, async (tx) => {
      const repository = new PracticeRepository(tx);
      const audit = new AuditService(tx);

      const dto = await repository.getPracticeById(input.tenantId, input.practiceId);
      if (input.userId && dto.userId !== input.userId) {
        throw new NotFoundError('Practice not found');
      }

      await repository.deletePracticeById(input.tenantId, input.practiceId);
      await audit.logEvent({
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        eventType: 'PRACTICE_DELETED',
        payload: { practiceId: input.practiceId },
      });

      return toView(dto);
    });
  }

  async exportPractices(input: {
    tenantId: string;
    userId?: string;
    filter: PracticeExportFilter;
  }): Promise<PracticeExportResult> {
    const all = await this.listPractices({
      tenantId: input.tenantId,
      userId: input.userId,
    });
    const practices = all.filter((practice) =>
      isWithinExportFilter(practice.createdAt, input.filter),
    );

    const csvRows = practices.map(
      (practice) =>
        `${escapeCsvField(practice.name)},${escapeCsvField(practice.createdAt.toISOString())}`,
    );

    return {
      filter: input.filter,
      title: exportFilterTitle(input.filter),
      csv: practices.length === 0 ? '' : `Nome,Data Creazione\n${csvRows.join('\n')}\n`,
      practices,
    };
  }

  async executeCommand(
    command: PracticeCommand,
    actor: PracticeActor,
  ): Promise<PracticeCommandResult> {
    switch (command.type) {
      case 'CREATE_PRACTICE':
        return {
          type: 'created',
          practice: await this.createPractice({
            tenantId: actor.tenantId,
            userId: actor.userId,
            name: command.payload.name,
            kind: 'music',
          }),
        };

      case 'LIST_PRACTICES':
        return {
          type: 'list',
          practices: await this.listPractices({
            tenantId: actor.tenantId,
            userId: actor.userId,
          }),
        };

      case 'GET_PRACTICE_STATUS': {
        const practice = await this.findPracticeByName(actor, command.payload.name);
        return practice
          ? { type: 'status', practice }
          : { type: 'not_found', name: command.payload.name };
      }

      case 'DELETE_PRACTICE': {
        const practice = await this.findPracticeByName(actor, command.payload.name);
        if (!practice) {
          return { type: 'not_found', name: command.payload.name };
        }

        return {
          type: 'deleted',
          practice: await this.deletePractice({
            tenantId: actor.tenantId,
            practiceId: practice.id,
            userId: actor.userId,
          }),
        };
      }

      case 'EXPORT_PRACTICES':
        return {
          type: 'export',
          result: await this.exportPractices({
            tenantId: actor.tenantId,
            userId: actor.userId,
            filter: command.payload.filter,
          }),
          send: command.payload.send,
        };
    }
  }

  private async findPracticeByName(
    actor: PracticeActor,
    name: string,
  ): Promise<PracticeView | null> {
    const needle = name.trim().toLowerCase();
    if (!needle) return null;

    const practices = await this.listPractices({
      tenantId: actor.tenantId,
      userId: actor.userId,
    });
    return practices.find((practice) => practice.name.toLowerCase() === needle) ?? null;
  }
}
