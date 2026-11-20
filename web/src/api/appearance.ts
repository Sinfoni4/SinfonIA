/**
 * The background of the Telegram Mini App, chosen by an administrator of the organization. The
 * server checks the same rule (src/core/organization/organization-appearance.ts): a #rrggbb color
 * dark enough for the white text and icons, at least 4.5:1 against white.
 */

/** GET /organization/appearance. */
export type Appearance = { background: string | null };

export const DEFAULT_BACKGROUND = '#1f1f1f';
export const MIN_CONTRAST_WITH_WHITE = 4.5;

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: string): boolean {
  return HEX.test(value.trim());
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.trim().slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** The contrast of a #rrggbb color against white, from 1 (white) to 21 (black). */
export function contrastWithWhite(hex: string): number {
  const [r, g, b] = rgb(hex);
  const l = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return 1.05 / (l + 0.05);
}

/** A color the Mini App can use: valid and dark enough for white text. */
export function isReadableBackground(value: string): boolean {
  return isHexColor(value) && contrastWithWhite(value) >= MIN_CONTRAST_WITH_WHITE;
}

/** The color with `amount` of white over it (0-1), as #rrggbb: the cards on the background. */
function lighten(hex: string, amount: number): string {
  return `#${rgb(hex)
    .map((c) => Math.round(c + (255 - c) * amount))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * The colors of the Mini App from its background: panels and cards are the background with a
 * little white, as #262626, #2a2a2a and #333333 are on the default #1f1f1f. Plain colors, not
 * transparent ones, so a sheet still hides what is under it.
 */
export function miniAppPalette(background: string | null | undefined): Record<string, string> {
  const bg = background && isReadableBackground(background) ? background : DEFAULT_BACKGROUND;
  return {
    '--ma-bg': bg,
    '--ma-panel': lighten(bg, 0.031),
    '--ma-card': lighten(bg, 0.049),
    '--ma-card-strong': lighten(bg, 0.089),
  };
}
