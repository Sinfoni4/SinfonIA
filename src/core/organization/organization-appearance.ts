import { NotFoundError } from '../../data/errors/errors.js';

import type { PrismaClient } from '@prisma/client';

/**
 * How the Telegram Mini App looks for an organization: its background color, chosen by an
 * administrator (an earthy brown for a farm network, an institutional blue for an association).
 * Text and icons of the Mini App stay white, so the color must be dark enough to read them:
 * at least 4.5:1 against white (WCAG AA for normal text). The dashboard checks the same rule
 * (web/src/api/appearance.ts) to warn before saving.
 */

/** The default of the Mini App, also what null means. */
export const DEFAULT_MINIAPP_BACKGROUND = '#1f1f1f';

/** WCAG AA for normal text. */
export const MIN_CONTRAST_WITH_WHITE = 4.5;

export class AppearanceRejectedError extends Error {
  readonly statusCode = 400;
  readonly code = 'APPEARANCE_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'AppearanceRejectedError';
  }
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The contrast of a #rrggbb color against white, from 1 (white) to 21 (black). */
export function contrastWithWhite(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const l =
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff);
  return 1.05 / (l + 0.05);
}

/** A background to store: `#rrggbb` in lowercase, or null for the default. */
export function checkBackground(value: string | null): string | null {
  if (value === null) return null;
  const clean = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(clean)) {
    throw new AppearanceRejectedError('Colore non valido: usa il formato #RRGGBB');
  }
  if (contrastWithWhite(clean) < MIN_CONTRAST_WITH_WHITE) {
    throw new AppearanceRejectedError(
      'Colore troppo chiaro: testi e icone bianchi della Mini App non si leggerebbero',
    );
  }
  return clean === DEFAULT_MINIAPP_BACKGROUND ? null : clean;
}

export type OrganizationAppearance = { background: string | null };

/** What the Mini App needs to dress itself (the logo comes from GET /organization/logo). */
export async function readOrganizationAppearance(
  prisma: PrismaClient,
  orgId: string,
): Promise<OrganizationAppearance> {
  const org = await prisma.tenant.findUnique({
    where: { id: orgId },
    select: { miniAppBackground: true },
  });
  if (!org) throw new NotFoundError('Organization not found');
  return { background: org.miniAppBackground };
}
