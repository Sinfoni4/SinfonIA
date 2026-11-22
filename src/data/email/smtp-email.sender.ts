import nodemailer from 'nodemailer';

import type { SmtpSettings } from '../../config/config.js';
import type { EmailMessage, EmailSender } from '../../core/email/email.sender.js';

/** The part of a nodemailer transport used here, so tests can inject their own. */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  verify(): Promise<unknown>;
}

/**
 * Transactional emails (login codes, invitations) through an SMTP server (D11). Plain text only;
 * TLS is always required: from the first byte on port 465, STARTTLS otherwise. The password stays
 * inside the transport and never appears in errors or logs.
 */
export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly from: string,
    private readonly transport: MailTransport,
  ) {}

  static fromSettings(settings: SmtpSettings): SmtpEmailSender {
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: !settings.secure,
      auth: { user: settings.user, pass: settings.password },
      tls: { minVersion: 'TLSv1.2', servername: settings.host },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return new SmtpEmailSender(settings.from, transport);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }

  /** Connects and logs in without sending anything: a wrong host or password shows at start. */
  async verify(): Promise<void> {
    await this.transport.verify();
  }
}
