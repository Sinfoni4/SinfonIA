/**
 * A1 in the chat: after a document read with doubts the bot asks for «conferma»; that answer
 * confirms the data as read, anything else leaves the document to verify in the dashboard.
 */
import { describe, expect, it, vi } from 'vitest';

import { ConversationService } from '../src/interface/conversation/conversation.service.js';

import type { Tenant } from '../src/core/tenant/tenant.store.js';

const tenant = { id: 't-1', name: 'Cooperativa' } as Tenant;
const PRACTICE = { id: 'p-1', name: 'Mario Rossi', status: 'CREATED' };

function setup(reviewRequired: boolean) {
  const addAttachment = vi.fn().mockResolvedValue({
    attachment: { id: 'a-1', ocrStatus: 'COMPLETED' },
    ocrResult: {
      documentType: 'receipt',
      merchantName: 'Bar Centrale',
      merchantVat: null,
      documentDate: '2026-10-31',
      totalAmount: 9.35,
      currency: 'EUR',
      missingFields: reviewRequired ? ['merchantVat'] : [],
      warnings: [],
      reviewRequired,
    },
  });
  const confirmDocument = vi.fn().mockResolvedValue(undefined);
  const handleMessage = vi.fn().mockResolvedValue('risposta AI');
  const service = new ConversationService(
    {
      practiceService: {
        executeCommand: vi.fn(),
        addAttachment,
        listPractices: vi.fn().mockResolvedValue([PRACTICE]),
      },
      handleMessage,
      confirmDocument,
    },
    {
      name: 'telegram',
      identity: {
        link: () => Promise.resolve(null),
        resolve: () =>
          Promise.resolve({ tenant, userId: 'u-1', role: 'MEMBER', customPermissions: null }),
      },
    },
  );
  const replies: string[] = [];
  const send = (text: string, withFile = false) =>
    service.handle(
      {
        senderId: '1',
        text,
        ...(withFile
          ? {
              file: {
                fileName: 'scontrino.jpg',
                mimeType: 'image/jpeg',
                download: () => Promise.resolve(Buffer.from('x')),
              },
            }
          : {}),
      },
      (t) => {
        replies.push(t);
        return Promise.resolve();
      },
    );
  return { send, replies, confirmDocument, handleMessage };
}

describe('confirming a document in the chat (A1)', () => {
  it('asks for «conferma» after a doubtful reading and confirms with it', async () => {
    const c = setup(true);
    await c.send('', true);
    expect(c.replies.at(-1)).toContain('rispondi «conferma»');
    await c.send('Conferma');
    expect(c.confirmDocument).toHaveBeenCalledWith({
      tenantId: 't-1',
      userId: 'u-1',
      practiceId: 'p-1',
      attachmentId: 'a-1',
    });
    expect(c.replies.at(-1)).toBe('✅ Dati del documento confermati.');
    expect(c.handleMessage).not.toHaveBeenCalled();
  });

  it('leaves the document to verify when the answer is something else', async () => {
    const c = setup(true);
    await c.send('', true);
    await c.send('lo controllo dopo');
    expect(c.confirmDocument).not.toHaveBeenCalled();
    expect(c.handleMessage).toHaveBeenCalledWith('lo controllo dopo', expect.anything());
    await c.send('conferma');
    expect(c.confirmDocument).not.toHaveBeenCalled();
  });

  it('does not ask when the reading had no doubts', async () => {
    const c = setup(false);
    await c.send('', true);
    expect(c.replies.at(-1)).not.toContain('conferma');
  });
});
