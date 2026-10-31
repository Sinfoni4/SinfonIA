import type { PlatformRole, PrismaClient } from '@prisma/client';

/**
 * Who may use the platform console (docs/PROGETTO_FRONTEND_V2.md §5.2, G1-G4): a person with the
 * platform role, read from the database at every request, in a login session opened with a code
 * in the last 12 hours. Being a platform administrator gives no right in any organization, and an
 * organization role gives no right on the platform.
 */

/** G2: the console needs a login code entered in the last 12 hours. */
export const PLATFORM_RECENT_LOGIN_MS = 12 * 60 * 60_000;

export type PlatformPrincipal = { userId: string; sessionId: string; email: string };

export function isPlatformAdmin(role: PlatformRole): boolean {
  return role === 'PLATFORM_ADMIN';
}

/** Refused: why, so that the console can ask for a new login instead of an error. */
export type PlatformRefusal = 'not-admin' | 'reauth';

export class PlatformAccessError extends Error {
  readonly statusCode = 401;
  readonly code: 'PLATFORM_FORBIDDEN' | 'PLATFORM_REAUTH';
  constructor(reason: PlatformRefusal) {
    super(
      reason === 'reauth'
        ? 'Per la console serve un accesso recente: entra di nuovo con il codice'
        : 'Accesso alla console non consentito',
    );
    this.name = 'PlatformAccessError';
    this.code = reason === 'reauth' ? 'PLATFORM_REAUTH' : 'PLATFORM_FORBIDDEN';
  }
}

/**
 * Checks a person and a session for the console; throws PlatformAccessError when refused.
 * The same rule serves the platform token (at issue) and every console request.
 */
export async function resolvePlatformPrincipal(
  prisma: Pick<PrismaClient, 'user' | 'session'>,
  identity: { userId: string; sessionId: string; authVersion: number },
  now = new Date(),
): Promise<PlatformPrincipal> {
  const user = await prisma.user.findUnique({
    where: { id: identity.userId },
    select: { email: true, status: true, platformRole: true, authVersion: true },
  });
  if (
    !user ||
    user.status !== 'ACTIVE' ||
    !isPlatformAdmin(user.platformRole) ||
    user.authVersion !== identity.authVersion
  ) {
    throw new PlatformAccessError('not-admin');
  }
  const session = await prisma.session.findFirst({
    where: {
      id: identity.sessionId,
      userId: identity.userId,
      revokedAt: null,
      expiresAt: { gt: now },
      authVersion: identity.authVersion,
    },
    select: { createdAt: true },
  });
  if (!session) throw new PlatformAccessError('not-admin');
  if (now.getTime() - session.createdAt.getTime() > PLATFORM_RECENT_LOGIN_MS) {
    throw new PlatformAccessError('reauth');
  }
  return { userId: identity.userId, sessionId: identity.sessionId, email: user.email };
}
