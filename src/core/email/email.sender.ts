/**
 * Sending of transactional emails (login codes, invitations), independent of the provider
 * (D11 still open): the real SMTP implementation comes with the choice of the provider. Until then
 * the simulated sender keeps the messages in memory, for tests and development.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class SimulatedEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** Last message sent to an address (case-insensitive), for tests. */
  lastTo(address: string): EmailMessage | undefined {
    const wanted = address.trim().toLowerCase();
    return this.sent.filter((m) => m.to.toLowerCase() === wanted).at(-1);
  }
}
