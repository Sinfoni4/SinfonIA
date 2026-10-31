import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { isPlatformAdmin, resolvePlatformPrincipal } from '../authz/platform.js';

import { revokeAllSessions } from './revocation.service.js';

import type { EmailSender } from '../email/email.sender.js';
import type { PrismaClient, UserRole } from '@prisma/client';

/**
 * Login with a one-time code by email, sessions with a rotated refresh token, and named
 * invitations (MF6, docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §4.1-§4.2). The email provider is
 * not chosen yet (D11): the sender is injected, simulated until then.
 *
 * - Codes: 6 digits, 10 minutes, stored as an HMAC with the server secret, at most 5 attempts,
 *   consumed atomically once.
 * - Starting a login answers the same way whether the email exists or not.
 * - Refresh token `<sessionId>.<random>`: only its hash is stored; it changes at every use, and
 *   presenting an old one revokes the session (a stolen token used twice).
 * - Placeholder emails of chat accounts (`@local.invalid`) never log in; an email shared by
 *   several legacy accounts does not either, until they are merged by an administrator (D8).
 */

export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
/** Codes an email can request per hour. */
export const MAX_CHALLENGES_PER_HOUR = 5;
/** Proposal: a session lasts 30 days, the access token 10 minutes. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;

export class LoginError extends Error {
  readonly statusCode = 401;
  readonly code = 'LOGIN_FAILED';
  constructor() {
    // Always the same message: it must not tell why (unknown email, wrong or expired code).
    super('Codice non valido o scaduto');
    this.name = 'LoginError';
  }
}

export type LoginSession = {
  userId: string;
  sessionId: string;
  refreshToken: string;
  organizations: Array<{ orgId: string; name: string; role: UserRole }>;
  /** A platform administrator: the console is offered too (G1). */
  platform: boolean;
};

export type AccessGrant = {
  userId: string;
  orgId: string;
  role: UserRole;
  sessionId: string;
  authVersion: number;
  refreshToken: string;
};

type Log = {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
};

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Email fingerprint for logs: never the address itself. */
function emailRef(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 12);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type LoginServiceOptions = {
  log?: Log;
  now?: () => Date;
  /**
   * Development only (F5): the code is also returned to the caller, so a developer can log in
   * with the simulated email. The configuration refuses it outside NODE_ENV=development.
   */
  exposeCodes?: boolean;
  /**
   * Public address of the dashboard (WEB_PUBLIC_URL): the invitation email carries a link to the
   * acceptance page, with the token after `#` so it never reaches server logs or other sites.
   */
  webUrl?: string;
};

export type InvitationView = {
  id: string;
  email: string;
  role: UserRole;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: Date;
  createdAt: Date;
};

export class LoginService {
  private readonly log?: Log;
  private readonly now: () => Date;
  private readonly exposeCodes: boolean;
  private readonly webUrl?: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly email: EmailSender,
    private readonly secret: string,
    options: LoginServiceOptions = {},
  ) {
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
    this.exposeCodes = options.exposeCodes ?? false;
    this.webUrl = options.webUrl?.replace(/\/+$/, '');
  }

  private codeHash(challengeId: string, code: string): string {
    return createHmac('sha256', this.secret).update(`${challengeId}:${code}`).digest('hex');
  }

  /** The only active account with that email, or null (none, placeholder, or ambiguous). */
  private async accountFor(email: string): Promise<string | null> {
    const normalized = normalizeEmail(email);
    if (!normalized.includes('@') || PLACEHOLDER_EMAIL.test(normalized)) return null;
    const users = await this.prisma.user.findMany({
      where: { email: { equals: normalized, mode: 'insensitive' }, status: 'ACTIVE' },
      select: { id: true },
      take: 2,
    });
    if (users.length > 1) {
      this.log?.warn({ email: emailRef(email) }, 'Login refused: email shared by several accounts');
    }
    return users.length === 1 ? users[0].id : null;
  }

  private async createChallenge(
    purpose: 'LOGIN' | 'INVITATION' | 'STEP_UP',
    email: string,
    userId: string | null,
  ): Promise<{ id: string; code: string } | null> {
    const normalized = normalizeEmail(email);
    const recent = await this.prisma.authChallenge.count({
      where: {
        purpose,
        email: normalized,
        createdAt: { gt: new Date(this.now().getTime() - 60 * 60_000) },
      },
    });
    if (recent >= MAX_CHALLENGES_PER_HOUR) return null;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = randomUUID();
    await this.prisma.authChallenge.create({
      data: {
        id,
        purpose,
        email: normalized,
        userId,
        codeHash: this.codeHash(id, code),
        expiresAt: new Date(this.now().getTime() + LOGIN_CODE_TTL_MS),
      },
    });
    return { id, code };
  }

  /**
   * Starts a login. The answer (a challenge id) is the same for any email: a challenge exists even
   * when no account matches, it just can never be verified and no email is sent.
   */
  async startLogin(email: string): Promise<{ challengeId: string; devCode?: string }> {
    const userId = await this.accountFor(email);
    const challenge = await this.createChallenge('LOGIN', email, userId);
    if (!challenge) {
      this.log?.warn({ email: emailRef(email) }, 'Login codes per hour exceeded');
      // Same shape of answer: a random id that matches no challenge.
      return { challengeId: randomUUID() };
    }
    if (userId) {
      await this.email.send({
        to: normalizeEmail(email),
        subject: 'Il tuo codice di accesso a SinfonIA',
        text:
          `Il tuo codice di accesso è ${challenge.code}.\n` +
          'Vale 10 minuti e una sola volta. Se non hai chiesto tu di accedere, ignora questo messaggio.',
      });
      if (this.exposeCodes) return { challengeId: challenge.id, devCode: challenge.code };
    }
    return { challengeId: challenge.id };
  }

  /**
   * Checks a code: one attempt is counted before comparing, and the challenge is consumed in the
   * same statement that accepts it, so two concurrent requests cannot both use it.
   */
  private async consumeChallenge(
    challengeId: string,
    code: string,
    purpose: 'LOGIN' | 'INVITATION' | 'STEP_UP',
  ): Promise<{ email: string | null; userId: string | null }> {
    if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) throw new LoginError();
    const counted = await this.prisma.authChallenge.updateMany({
      where: {
        id: challengeId,
        purpose,
        consumedAt: null,
        expiresAt: { gt: this.now() },
        attempts: { lt: MAX_CODE_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) throw new LoginError();
    const challenge = await this.prisma.authChallenge.findUniqueOrThrow({
      where: { id: challengeId },
      select: { codeHash: true, email: true, userId: true },
    });
    const expected = Buffer.from(challenge.codeHash, 'hex');
    const given = Buffer.from(this.codeHash(challengeId, code), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new LoginError();
    }
    const consumed = await this.prisma.authChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: this.now() },
    });
    if (consumed.count !== 1) throw new LoginError();
    return { email: challenge.email, userId: challenge.userId };
  }

  private async openSession(userId: string): Promise<LoginSession> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE' },
      select: { authVersion: true, emailVerifiedAt: true, platformRole: true },
    });
    if (!user) throw new LoginError();
    const secret = randomBytes(32).toString('base64url');
    const session = await this.prisma.session.create({
      data: {
        userId,
        authVersion: user.authVersion,
        refreshTokenHash: sha256(secret),
        expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS),
      },
      select: { id: true },
    });
    if (!user.emailVerifiedAt) {
      // The code proves control of the mailbox (not the legal identity).
      await this.prisma.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: this.now() },
      });
    }
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'ACTIVE', org: { status: 'ACTIVE' } },
      orderBy: { createdAt: 'asc' },
      select: { orgId: true, role: true, org: { select: { name: true } } },
    });
    const audit = new AuditService(this.prisma);
    for (const m of memberships) {
      await audit.logEvent({
        tenantId: m.orgId,
        userId,
        eventType: 'LOGIN_SUCCEEDED',
        payload: { sessionId: session.id },
      });
    }
    return {
      userId,
      sessionId: session.id,
      refreshToken: `${session.id}.${secret}`,
      organizations: memberships.map((m) => ({ orgId: m.orgId, name: m.org.name, role: m.role })),
      platform: isPlatformAdmin(user.platformRole),
    };
  }

  async verifyLogin(challengeId: string, code: string): Promise<LoginSession> {
    try {
      const { userId } = await this.consumeChallenge(challengeId, code, 'LOGIN');
      if (!userId) throw new LoginError();
      return await this.openSession(userId);
    } catch (err: unknown) {
      if (err instanceof LoginError) this.log?.warn({ challengeId }, 'Login failed');
      throw err;
    }
  }

  /**
   * Access to one organization with a refresh token, which is replaced (rotation). An old token
   * presented again revokes the whole session.
   */
  async refresh(refreshToken: string, orgId: string): Promise<AccessGrant> {
    const session = await this.checkSession(refreshToken);
    const membership = await this.prisma.membership.findFirst({
      where: { userId: session.userId, orgId, status: 'ACTIVE', org: { status: 'ACTIVE' } },
      select: { role: true },
    });
    if (!membership) throw new LoginError();
    return {
      userId: session.userId,
      orgId,
      role: membership.role,
      sessionId: session.id,
      authVersion: session.authVersion,
      refreshToken: await this.rotate(session),
    };
  }

  /**
   * Access to the platform console (G1, G2) with the same session: only for a platform
   * administrator whose login code is recent. Rotates the refresh token like `refresh`.
   */
  async refreshPlatform(refreshToken: string): Promise<{
    userId: string;
    sessionId: string;
    authVersion: number;
    refreshToken: string;
  }> {
    const session = await this.checkSession(refreshToken);
    await resolvePlatformPrincipal(
      this.prisma,
      { userId: session.userId, sessionId: session.id, authVersion: session.authVersion },
      this.now(),
    );
    return {
      userId: session.userId,
      sessionId: session.id,
      authVersion: session.authVersion,
      refreshToken: await this.rotate(session),
    };
  }

  /** The open session of a refresh token; an old token presented again revokes the session. */
  private async checkSession(refreshToken: string) {
    const [sessionId, secret] = refreshToken.split('.');
    if (!sessionId || !secret || !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new LoginError();
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        authVersion: true,
        refreshTokenHash: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { status: true, authVersion: true } },
      },
    });
    if (!session || session.revokedAt || session.expiresAt <= this.now()) throw new LoginError();
    if (session.refreshTokenHash !== sha256(secret)) {
      await this.prisma.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: this.now(), revocationReason: 'refresh token reused' },
      });
      this.log?.warn({ sessionId }, 'Refresh token reused: session revoked');
      throw new LoginError();
    }
    if (session.user.status !== 'ACTIVE' || session.user.authVersion !== session.authVersion) {
      throw new LoginError();
    }
    return session;
  }

  /** Replaces the refresh token of a checked session; returns the new one. */
  private async rotate(session: { id: string; refreshTokenHash: string }): Promise<string> {
    const next = randomBytes(32).toString('base64url');
    const rotated = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      data: { refreshTokenHash: sha256(next), lastSeenAt: this.now() },
    });
    // Another request rotated it first: this one carried a token that is now old.
    if (rotated.count !== 1) throw new LoginError();
    return `${session.id}.${next}`;
  }

  /**
   * G2: a fresh code to the platform administrator's own email, required by every critical
   * action of the console (new organization, suspension). Returned in development only.
   */
  async startStepUp(userId: string): Promise<{ challengeId: string; devCode?: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    const challenge = await this.createChallenge('STEP_UP', user.email, userId);
    if (!challenge) throw new InvitationError('Troppi codici richiesti: riprova più tardi');
    await this.email.send({
      to: normalizeEmail(user.email),
      subject: 'Codice di conferma per la console di SinfonIA',
      text:
        `Il codice per confermare l'operazione nella console è ${challenge.code}.\n` +
        'Vale 10 minuti e una sola volta. Se non stai usando la console, avvisa gli altri gestori.',
    });
    return this.exposeCodes
      ? { challengeId: challenge.id, devCode: challenge.code }
      : { challengeId: challenge.id };
  }

  /** Consumes a confirmation code of that same person, or throws LoginError (401). */
  async confirmStepUp(userId: string, challengeId: string, code: string): Promise<void> {
    const challenge = await this.consumeChallenge(challengeId, code, 'STEP_UP');
    if (challenge.userId !== userId) throw new LoginError();
  }

  async logout(refreshToken: string): Promise<void> {
    const [sessionId, secret] = refreshToken.split('.');
    if (!sessionId || !secret || !/^[0-9a-f-]{36}$/i.test(sessionId)) return;
    await this.prisma.session.updateMany({
      where: { id: sessionId, refreshTokenHash: sha256(secret), revokedAt: null },
      data: { revokedAt: this.now(), revocationReason: 'logout' },
    });
  }

  // --- invitations ------------------------------------------------------------------------------

  /** A named, single-use invitation; the token goes only to the invited email. */
  async createInvitation(
    orgId: string,
    email: string,
    role: UserRole,
    /** `platform`: sent from the platform console, whose administrator is not a member. */
    actor: { userId: string; platform?: boolean },
  ): Promise<{ invitationId: string; devToken?: string }> {
    const normalized = normalizeEmail(email);
    if (!normalized.includes('@') || PLACEHOLDER_EMAIL.test(normalized)) {
      throw new InvitationError('Indirizzo email non valido');
    }
    const token = randomBytes(32).toString('base64url');
    const org = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: orgId },
      select: { name: true },
    });
    const invitation = await withTransaction(this.prisma, async (tx) => {
      const created = await tx.invitation.create({
        data: {
          orgId,
          email: normalized,
          role,
          tokenHash: sha256(token),
          expiresAt: new Date(this.now().getTime() + INVITATION_TTL_MS),
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      await new AuditService(tx).logEvent({
        tenantId: orgId,
        userId: actor.platform ? null : actor.userId,
        eventType: 'INVITATION_CREATED',
        payload: {
          invitationId: created.id,
          role,
          ...(actor.platform ? { byPlatform: true } : {}),
        },
      });
      return created;
    });
    await this.email.send({
      to: normalized,
      subject: `Invito a ${org.name} su SinfonIA`,
      text:
        `Sei stato invitato a lavorare per ${org.name} su SinfonIA.\n` +
        (this.webUrl ? `Accetta l'invito: ${this.webUrl}/app/invito#${token}\n` : '') +
        `Codice invito: ${token}\nVale 7 giorni e una sola volta.`,
    });
    // Development only (F5): the administrator can try the acceptance without a real mailbox.
    return this.exposeCodes
      ? { invitationId: invitation.id, devToken: token }
      : { invitationId: invitation.id };
  }

  async revokeInvitation(orgId: string, invitationId: string, actor: { userId: string }) {
    const { count } = await this.prisma.invitation.updateMany({
      where: { id: invitationId, orgId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    if (count === 1) {
      await new AuditService(this.prisma).logEvent({
        tenantId: orgId,
        userId: actor.userId,
        eventType: 'INVITATION_REVOKED',
        payload: { invitationId },
      });
    }
    return count === 1;
  }

  private async openInvitation(token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: sha256(token) },
      select: {
        id: true,
        orgId: true,
        email: true,
        role: true,
        acceptedAt: true,
        revokedAt: true,
        expiresAt: true,
      },
    });
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= this.now()
    ) {
      throw new InvitationError('Invito non valido o scaduto');
    }
    return invitation;
  }

  /** Sends a code to the invited email: accepting proves control of that same mailbox. */
  async startInvitation(token: string): Promise<{ challengeId: string; devCode?: string }> {
    const invitation = await this.openInvitation(token);
    const challenge = await this.createChallenge('INVITATION', invitation.email, null);
    if (!challenge) throw new InvitationError('Troppe richieste: riprova più tardi');
    await this.email.send({
      to: invitation.email,
      subject: 'Conferma il tuo invito su SinfonIA',
      text: `Il codice per accettare l'invito è ${challenge.code}. Vale 10 minuti.`,
    });
    return this.exposeCodes
      ? { challengeId: challenge.id, devCode: challenge.code }
      : { challengeId: challenge.id };
  }

  /** Invitations of an organization, newest first, with their state (no token). */
  async listInvitations(orgId: string): Promise<InvitationView[]> {
    const rows = await this.prisma.invitation.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        email: true,
        role: true,
        acceptedAt: true,
        revokedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    const now = this.now();
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      status: r.acceptedAt
        ? 'ACCEPTED'
        : r.revokedAt
          ? 'REVOKED'
          : r.expiresAt <= now
            ? 'EXPIRED'
            : 'PENDING',
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Who the person is and where they can work (B9): what the dashboard shows after a reload,
   * when only the access token is in memory. Placeholder emails of chat accounts are hidden.
   */
  async profile(userId: string): Promise<{
    userId: string;
    email: string | null;
    organizations: Array<{ orgId: string; name: string; role: UserRole }>;
    platform: boolean;
  }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, platformRole: true },
    });
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'ACTIVE', org: { status: 'ACTIVE' } },
      orderBy: { createdAt: 'asc' },
      select: { orgId: true, role: true, org: { select: { name: true } } },
    });
    return {
      userId,
      email: PLACEHOLDER_EMAIL.test(user.email) ? null : user.email,
      organizations: memberships.map((m) => ({ orgId: m.orgId, name: m.org.name, role: m.role })),
      platform: isPlatformAdmin(user.platformRole),
    };
  }

  /** «Esci da tutti i dispositivi»: every session and token of the person ends (MF5). */
  async logoutEverywhere(userId: string): Promise<void> {
    await revokeAllSessions(this.prisma, userId, { userId });
  }

  /**
   * Accepts an invitation with the code sent to the invited email: a membership for an existing
   * person with that email, otherwise a new person. Never more than once.
   */
  async acceptInvitation(token: string, challengeId: string, code: string): Promise<LoginSession> {
    const invitation = await this.openInvitation(token);
    const challenge = await this.consumeChallenge(challengeId, code, 'INVITATION');
    if (challenge.email !== invitation.email) throw new LoginError();

    const userId = await withTransaction(this.prisma, async (tx) => {
      const accepted = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: this.now() },
      });
      if (accepted.count !== 1) throw new InvitationError('Invito non valido o scaduto');
      const existing = await tx.user.findMany({
        where: { email: { equals: invitation.email, mode: 'insensitive' }, status: 'ACTIVE' },
        select: { id: true },
        take: 2,
      });
      if (existing.length > 1) {
        throw new InvitationError("L'email appartiene a più account: serve l'amministratore");
      }
      let id: string;
      if (existing.length === 1) {
        id = existing[0].id;
        await tx.membership.upsert({
          where: { userId_orgId: { userId: id, orgId: invitation.orgId } },
          create: { userId: id, orgId: invitation.orgId, role: invitation.role, invitedBy: null },
          update: {
            role: invitation.role,
            status: 'ACTIVE',
            revokedAt: null,
            revokedBy: null,
            revocationReason: null,
          },
        });
      } else {
        // New person: the legacy columns still need an organization (until M3).
        const created = await tx.user.create({
          data: {
            tenantId: invitation.orgId,
            email: invitation.email,
            role: invitation.role,
            emailVerifiedAt: this.now(),
          },
          select: { id: true },
        });
        id = created.id;
      }
      await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedBy: id } });
      await new AuditService(tx).logEvent({
        tenantId: invitation.orgId,
        userId: id,
        eventType: 'INVITATION_ACCEPTED',
        payload: { invitationId: invitation.id, role: invitation.role },
      });
      return id;
    });
    return this.openSession(userId);
  }
}

export class InvitationError extends Error {
  readonly statusCode = 409;
  readonly code = 'INVITATION_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'InvitationError';
  }
}
