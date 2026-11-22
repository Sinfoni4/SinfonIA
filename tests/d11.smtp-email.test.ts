/**
 * D11: transactional emails through SMTP. The configuration needs all four values together,
 * production allows email login only with SMTP, and the sender builds a plain-text message with
 * the configured sender. No network: the transport is nodemailer's in-memory stream.
 */
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';

import { loadConfig, smtpSettings } from '../src/config/config.js';
import { SmtpEmailSender, type MailTransport } from '../src/data/email/smtp-email.sender.js';

import { TEST_AUTH_ENV } from './helpers/auth.js';

const BASE = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', ...TEST_AUTH_ENV };
const SMTP = {
  SMTP_HOST: 'authsmtp.example.test',
  SMTP_USER: 'noreply@example.test',
  SMTP_PASSWORD: 'not-a-real-password',
  EMAIL_FROM: 'SinfonIA <noreply@example.test>',
};

describe('D11 SMTP configuration', () => {
  it('is off without the SMTP values', () => {
    expect(smtpSettings(loadConfig(BASE))).toBeUndefined();
  });

  it('needs the four values together', () => {
    expect(() => loadConfig({ ...BASE, SMTP_HOST: SMTP.SMTP_HOST })).toThrow(
      /SMTP_HOST, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM together/,
    );
    expect(() => loadConfig({ ...BASE, ...SMTP, SMTP_PASSWORD: '' })).toThrow(/together/);
  });

  it('uses TLS from the start on port 465 and STARTTLS otherwise', () => {
    expect(smtpSettings(loadConfig({ ...BASE, ...SMTP }))).toEqual({
      host: SMTP.SMTP_HOST,
      port: 465,
      secure: true,
      user: SMTP.SMTP_USER,
      password: SMTP.SMTP_PASSWORD,
      from: SMTP.EMAIL_FROM,
    });
    expect(smtpSettings(loadConfig({ ...BASE, ...SMTP, SMTP_PORT: '587' }))).toMatchObject({
      port: 587,
      secure: false,
    });
    expect(
      smtpSettings(loadConfig({ ...BASE, ...SMTP, SMTP_PORT: '2525', SMTP_SECURE: 'true' })),
    ).toMatchObject({ port: 2525, secure: true });
  });

  it('allows email login in production only with SMTP', () => {
    const prod = { ...BASE, NODE_ENV: 'production', AUTH_EMAIL_LOGIN: 'true' };
    expect(() => loadConfig(prod)).toThrow(/AUTH_EMAIL_LOGIN in production needs SMTP_HOST/);
    expect(loadConfig({ ...prod, ...SMTP }).AUTH_EMAIL_LOGIN).toBe(true);
  });
});

describe('D11 SMTP sender', () => {
  it('sends a plain-text message from the configured sender', async () => {
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const raw: string[] = [];
    const transport: MailTransport = {
      sendMail: async (mail) => {
        const info = (await stream.sendMail(mail)) as { message: Buffer };
        raw.push(info.message.toString('utf8'));
        return info;
      },
      verify: () => Promise.resolve(true),
    };
    const sender = new SmtpEmailSender(SMTP.EMAIL_FROM, transport);

    await sender.send({
      to: 'persona@example.test',
      subject: 'Il tuo codice di accesso a SinfonIA',
      text: 'Il tuo codice di accesso è 123456.',
    });

    expect(raw).toHaveLength(1);
    const message = raw[0];
    expect(message).toMatch(/^From: SinfonIA <noreply@example\.test>$/m);
    expect(message).toMatch(/^To: persona@example\.test$/m);
    expect(message).toMatch(/^Subject: Il tuo codice di accesso a SinfonIA$/m);
    expect(message).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
    expect(message).not.toContain(SMTP.SMTP_PASSWORD);
  });

  it('reports a failed delivery to the caller', async () => {
    const sender = new SmtpEmailSender(SMTP.EMAIL_FROM, {
      sendMail: () => Promise.reject(new Error('535 Authentication failed')),
      verify: () => Promise.reject(new Error('535 Authentication failed')),
    });
    await expect(
      sender.send({ to: 'persona@example.test', subject: 's', text: 't' }),
    ).rejects.toThrow('535');
    await expect(sender.verify()).rejects.toThrow('535');
  });
});
