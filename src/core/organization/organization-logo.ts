import { NotFoundError } from '../../data/errors/errors.js';

import type { StorageService } from '../../data/storage/storage.service.js';
import type { PrismaClient } from '@prisma/client';

/**
 * The logo of an organization (shown in the Telegram Mini App next to its name). The platform
 * console uploads it; the file lives in the attachment storage, the tenant row keeps where it is.
 * The Mini App shows it as an image from a data URL, so an SVG never runs as a page; it is still
 * checked here, and refused when it holds scripts, events or links to other resources.
 */

export const LOGO_MAX_BYTES = 200 * 1024;

export const LOGO_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

const EXTENSIONS: Record<LogoType, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export class LogoRejectedError extends Error {
  readonly statusCode = 400;
  readonly code = 'LOGO_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'LogoRejectedError';
  }
}

/** What an SVG logo must not contain: active content, entities, or anything loaded from outside. */
const SVG_FORBIDDEN: Array<[RegExp, string]> = [
  [/<script\b/i, 'contiene uno script'],
  [/<foreignObject\b/i, 'contiene contenuto HTML'],
  [/<(iframe|embed|object|audio|video|image|use)\b/i, 'carica altri contenuti'],
  [/<!(DOCTYPE|ENTITY)\b/i, 'contiene dichiarazioni DOCTYPE o ENTITY'],
  [/\son[a-z]+\s*=/i, 'contiene gestori di eventi'],
  [/javascript\s*:/i, 'contiene un collegamento javascript'],
  [/\bhref\s*=/i, 'contiene collegamenti'],
  [/@import\b|url\s*\(/i, 'carica stili o immagini esterne'],
];

function startsWith(data: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((b, i) => data[offset + i] === b);
}

/** Checks the declared type against the content and the limits; returns the type to store. */
export function checkLogo(contentType: string, data: Buffer): LogoType {
  if (!(LOGO_TYPES as readonly string[]).includes(contentType)) {
    throw new LogoRejectedError('Formato non ammesso: usa SVG, PNG, JPEG o WebP');
  }
  if (data.length === 0) throw new LogoRejectedError('Il file è vuoto');
  if (data.length > LOGO_MAX_BYTES) {
    throw new LogoRejectedError(`Il file supera ${LOGO_MAX_BYTES / 1024} KB`);
  }
  const type = contentType as LogoType;
  const matches =
    type === 'image/png'
      ? startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : type === 'image/jpeg'
        ? startsWith(data, [0xff, 0xd8, 0xff])
        : type === 'image/webp'
          ? startsWith(data, [0x52, 0x49, 0x46, 0x46]) &&
            startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)
          : /<svg[\s>]/i.test(data.toString('utf8'));
  if (!matches) throw new LogoRejectedError('Il contenuto non corrisponde al formato dichiarato');
  if (type === 'image/svg+xml') {
    const text = data.toString('utf8');
    for (const [pattern, reason] of SVG_FORBIDDEN) {
      if (pattern.test(text)) throw new LogoRejectedError(`SVG non ammesso: ${reason}`);
    }
  }
  return type;
}

export function logoFileName(type: LogoType): string {
  return `logo.${EXTENSIONS[type]}`;
}

export type OrganizationLogo = { contentType: LogoType; data: string; updatedAt: Date };

/** The logo of an organization, in base64, or null when it has none (or the file is gone). */
export async function readOrganizationLogo(
  prisma: PrismaClient,
  storage: StorageService,
  orgId: string,
): Promise<OrganizationLogo | null> {
  const org = await prisma.tenant.findUnique({
    where: { id: orgId },
    select: { logoPath: true, logoType: true, logoUpdatedAt: true },
  });
  if (!org) throw new NotFoundError('Organization not found');
  if (!org.logoPath || !org.logoType || !(LOGO_TYPES as readonly string[]).includes(org.logoType)) {
    return null;
  }
  try {
    const data = await storage.read(orgId, org.logoPath);
    return {
      contentType: org.logoType as LogoType,
      data: data.toString('base64'),
      updatedAt: org.logoUpdatedAt ?? new Date(0),
    };
  } catch {
    // A file removed by hand (or a storage restored without it): the organization shows its
    // initials, as without a logo.
    return null;
  }
}
