import { formatItalianDate, parseIsoDate } from '../../core/compliance/compliance.dates.js';
import { COMPLIANCE_CATEGORY_LABELS } from '../../core/compliance/compliance.service.js';
import { ComplianceValidationError } from '../../core/errors/compliance.errors.js';
import { NotFoundError } from '../../data/errors/errors.js';

import type { ComplianceCommand } from '../../core/compliance/compliance.commands.js';
import type {
  ComplianceDeadlineView,
  ComplianceService,
} from '../../core/compliance/compliance.service.js';
import type { UserRole } from '@prisma/client';

const LIST_LIMIT = 15;

function dueText(deadline: ComplianceDeadlineView): string {
  const date = formatItalianDate(parseIsoDate(deadline.dueDate)!);
  if (deadline.daysLeft < 0) return `${date} — scaduta`;
  if (deadline.daysLeft === 0) return `${date} — oggi`;
  if (deadline.daysLeft === 1) return `${date} — domani`;
  return `${date} — tra ${deadline.daysLeft} giorni`;
}

export function formatDeadlineList(deadlines: ComplianceDeadlineView[]): string {
  if (deadlines.length === 0) {
    return '✅ Nessuna scadenza aperta.';
  }
  const lines = deadlines.map((d) => {
    const icon = d.daysLeft <= 7 ? '⚠️' : '📅';
    return `${icon} ${d.title}\n   ${COMPLIANCE_CATEGORY_LABELS[d.category]} · ${dueText(d)} · codice ${d.shortId}`;
  });
  return ['🗓️ Scadenze aperte', '', ...lines].join('\n');
}

/**
 * Runs a compliance command for a Telegram user. Members can list the deadlines that refer to
 * them; creating and closing deadlines is for operators and admins.
 */
export async function executeComplianceCommand(
  command: ComplianceCommand,
  ctx: {
    complianceService: Pick<
      ComplianceService,
      'listDeadlines' | 'createDeadline' | 'closeDeadline'
    >;
    tenantId: string;
    userId: string;
    role: UserRole;
  },
): Promise<string> {
  if (command.type === 'INVALID_COMPLIANCE_COMMAND') {
    return `⚠️ ${command.reason}`;
  }

  if (command.type === 'LIST_DEADLINES') {
    const deadlines = await ctx.complianceService.listDeadlines({
      tenantId: ctx.tenantId,
      status: 'OPEN',
      limit: LIST_LIMIT,
      ...(ctx.role === 'MEMBER' ? { userId: ctx.userId } : {}),
    });
    return formatDeadlineList(deadlines);
  }

  if (ctx.role === 'MEMBER') {
    return 'ℹ️ Le scadenze le gestiscono un operatore o un amministratore della tua cooperativa.';
  }

  try {
    if (command.type === 'CREATE_DEADLINE') {
      const created = await ctx.complianceService.createDeadline({
        tenantId: ctx.tenantId,
        createdBy: ctx.userId,
        category: command.payload.category,
        title: command.payload.title,
        dueDate: command.payload.dueDate,
      });
      return [
        '✅ Scadenza registrata',
        `📌 ${created.title}`,
        `${COMPLIANCE_CATEGORY_LABELS[created.category]} · ${dueText(created)}`,
        `Riceverai un promemoria a 30, 15, 7 e 1 giorno. Codice: ${created.shortId}`,
      ].join('\n');
    }

    const closed = await ctx.complianceService.closeDeadline({
      tenantId: ctx.tenantId,
      idOrPrefix: command.payload.code,
      closedBy: ctx.userId,
    });
    return `✅ Scadenza chiusa: ${closed.title}\nNon riceverai altri promemoria.`;
  } catch (err: unknown) {
    if (err instanceof NotFoundError) {
      return '⚠️ Scadenza non trovata. Controlla il codice con "scadenze".';
    }
    if (err instanceof ComplianceValidationError) {
      return `⚠️ ${err.message}`;
    }
    throw err;
  }
}
