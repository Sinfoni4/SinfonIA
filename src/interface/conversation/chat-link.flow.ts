import { ChannelLinkError } from '../../core/identity/channel-link.service.js';

import type { ChannelLinkService, LinkResult } from '../../core/identity/channel-link.service.js';
import type { ChannelType } from '@prisma/client';

/**
 * AGX-10 / MF7: the chat side of the verified link. Before the person is known:
 * - `/accedi` → the email → the code sent to that email, typed in this same chat → linked;
 * - `/collegamenti` lists the person's links, `/scollega` removes this one (after «sì»);
 * - the old `start <codice invito>` of an organization no longer links: it explains /accedi.
 */

export type ChannelLinkPort = Pick<
  ChannelLinkService,
  'start' | 'verify' | 'isLinked' | 'revokeFromChat' | 'listFromChat'
>;

type Reply = (
  text: string,
  options?: { buttons?: Array<{ label: string; answer: string }> },
) => Promise<unknown>;

type Pending =
  | { step: 'email'; expiresAt: number }
  | { step: 'code'; challengeId: string; misses: number; expiresAt: number }
  | { step: 'unlink'; expiresAt: number };

const ACCEDI = /^\/?(accedi|collega)$/i;
const COLLEGAMENTI = /^\/?collegamenti$/i;
const SCOLLEGA = /^\/?scollega$/i;
const LEGACY_LINK = /^\/?start\s+\S+/i;
const CANCEL = /^(annulla|no|stop)$/i;
const YES = /^(s[iì]|ok|conferma)$/i;
const CODE = /^\d{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STEP_MS = 10 * 60_000;
const MAX_MISSES = 5;

export const NOT_LINKED_TEXT =
  'Il tuo account non è ancora collegato a SinfonIA.\n' +
  'Scrivi /accedi: ti chiederò la tua email e ti manderò un codice per collegarti.';

export const LEGACY_LINK_TEXT =
  "I codici d'invito dell'organizzazione non servono più per collegarsi.\n" +
  'Scrivi /accedi: ti chiederò l’email con cui sei stato invitato e ti manderò un codice.';

const CHANNEL_LABEL: Record<ChannelType, string> = { TELEGRAM: 'Telegram', WHATSAPP: 'WhatsApp' };

const day = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

export class ChatLinkFlow {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly port: ChannelLinkPort | undefined,
    private readonly channel: ChannelType,
    private readonly welcome: (result: LinkResult) => Promise<string>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Handles the message when it belongs to linking; false lets the conversation go on. */
  async handle(senderId: string, text: string, reply: Reply): Promise<boolean> {
    const trimmed = text.trim();
    const pending = this.pending.get(senderId);
    if (pending && pending.expiresAt <= this.now()) this.pending.delete(senderId);
    const active = this.pending.get(senderId);

    if (ACCEDI.test(trimmed)) {
      this.pending.delete(senderId);
      if (!this.port) {
        await reply(
          'Il collegamento con email non è ancora attivo qui: chiedi all’amministratore della tua ' +
            'organizzazione.',
        );
        return true;
      }
      if (await this.port.isLinked(this.channel, senderId)) {
        await reply(
          'Questo account è già collegato. Scrivi /collegamenti per vederlo o /scollega per toglierlo.',
        );
        return true;
      }
      this.pending.set(senderId, { step: 'email', expiresAt: this.now() + STEP_MS });
      await reply(
        'Scrivi l’email con cui la tua organizzazione ti ha invitato (o quella del tuo account).\n' +
          'Ti manderò un codice di 6 cifre da scrivere qui. Per lasciar perdere scrivi «annulla».',
      );
      return true;
    }

    if (COLLEGAMENTI.test(trimmed) && this.port) {
      const links = await this.port.listFromChat(this.channel, senderId);
      if (!links) {
        await reply('Questo account non è collegato. Scrivi /accedi per collegarlo.');
        return true;
      }
      await reply(
        ['🔗 I tuoi collegamenti:']
          .concat(
            links.map(
              (l) =>
                `• ${CHANNEL_LABEL[l.channel]} ${l.ref}, dal ${day(l.linkedAt)}` +
                (l.verified ? '' : ' (collegato col vecchio codice d’invito)'),
            ),
          )
          .concat([
            '',
            'Per togliere questo scrivi /scollega; gli altri dal tuo profilo nella dashboard.',
          ])
          .join('\n'),
      );
      return true;
    }

    if (SCOLLEGA.test(trimmed) && this.port) {
      if (!(await this.port.isLinked(this.channel, senderId))) {
        await reply('Questo account non è collegato.');
        return true;
      }
      this.pending.set(senderId, { step: 'unlink', expiresAt: this.now() + STEP_MS });
      await reply(
        'Vuoi scollegare questo account? Il bot non ti riconoscerà più finché non ti ricolleghi ' +
          'con /accedi.',
        {
          buttons: [
            { label: '✅ Sì, scollega', answer: 'sì' },
            { label: '❌ No', answer: 'no' },
          ],
        },
      );
      return true;
    }

    if (active && this.port) {
      return this.continue(senderId, trimmed, active, reply);
    }

    if (LEGACY_LINK.test(trimmed)) {
      await reply(LEGACY_LINK_TEXT);
      return true;
    }
    return false;
  }

  private async continue(
    senderId: string,
    text: string,
    pending: Pending,
    reply: Reply,
  ): Promise<boolean> {
    const port = this.port!;
    if (pending.step === 'unlink') {
      this.pending.delete(senderId);
      if (YES.test(text)) {
        await port.revokeFromChat(this.channel, senderId);
        await reply('🔓 Account scollegato. Per ricollegarlo scrivi /accedi.');
        return true;
      }
      if (CANCEL.test(text)) {
        await reply('Va bene: l’account resta collegato.');
        return true;
      }
      return false;
    }
    if (CANCEL.test(text)) {
      this.pending.delete(senderId);
      await reply('Va bene, lasciamo perdere. Quando vuoi scrivi /accedi.');
      return true;
    }

    if (pending.step === 'email') {
      if (!EMAIL.test(text)) {
        await reply('Non sembra un’email: scrivila di nuovo, oppure «annulla».');
        return true;
      }
      try {
        const started = await port.start({
          channel: this.channel,
          externalId: senderId,
          email: text,
        });
        this.pending.set(senderId, {
          step: 'code',
          challengeId: started.challengeId,
          misses: 0,
          expiresAt: this.now() + STEP_MS,
        });
        await reply(
          'Se l’email risulta invitata o registrata, ti ho appena mandato un codice di 6 cifre: ' +
            'scrivilo qui. Vale 10 minuti.' +
            (started.devCode ? `\n(Ambiente di prova: il codice è ${started.devCode}.)` : ''),
        );
      } catch (err: unknown) {
        if (!(err instanceof ChannelLinkError)) throw err;
        this.pending.delete(senderId);
        await reply(`⚠️ ${err.message}.`);
      }
      return true;
    }

    // step 'code'
    if (!CODE.test(text)) {
      await reply('Scrivi il codice di 6 cifre che hai ricevuto per email, oppure «annulla».');
      return true;
    }
    try {
      const result = await port.verify({
        channel: this.channel,
        externalId: senderId,
        challengeId: pending.challengeId,
        code: text,
      });
      this.pending.delete(senderId);
      await reply(await this.welcome(result));
    } catch (err: unknown) {
      if (!(err instanceof ChannelLinkError)) throw err;
      const misses = pending.misses + 1;
      if (misses >= MAX_MISSES || err.message !== 'Codice non valido o scaduto') {
        this.pending.delete(senderId);
        await reply(`⚠️ ${err.message}. Scrivi /accedi per ricevere un nuovo codice.`);
      } else {
        this.pending.set(senderId, { ...pending, misses });
        await reply(
          '⚠️ Codice non valido o scaduto. Riprova, oppure scrivi /accedi per un codice nuovo.',
        );
      }
    }
    return true;
  }
}
