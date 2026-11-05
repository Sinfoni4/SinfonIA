import { expect, type Page } from '@playwright/test';

export const ADMIN = 'e2e.admin@sinfonia.test';
export const CONSULTANT = 'e2e.consulente@sinfonia.test';

/** Logs in with the development code shown on screen (the e2e server never sends emails). */
export async function login(page: Page, email = ADMIN): Promise<void> {
  await page.goto('./');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Ricevi il codice di accesso' }).click();
  const note = page.getByText(/il codice è \d{6}/);
  await expect(note).toBeVisible();
  const code = /(\d{6})/.exec((await note.textContent()) ?? '')?.[1];
  if (!code) throw new Error('No development code on screen');
  await page.getByLabel('Codice').fill(code);
  await page.getByRole('button', { name: 'Accedi' }).click();
  await expect(page.getByRole('list', { name: 'Indicatori' })).toBeVisible();
}

/** Opens a section of the header; on a phone through «Menu». */
export async function openSection(page: Page, name: string): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Menu' });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('navigation', { name: 'Sezioni' }).getByRole('link', { name }).click();
}

/** A name nobody else used in the run. */
export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

/**
 * FE5 (item 32): accessibility problems of the page, found in the browser without any library:
 * language, one main heading, a name for every field, button and link, alternative text for
 * images, and the contrast of text against its background (WCAG AA: 4.5, 3 for large text).
 */
export async function accessibilityProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems = new Set<string>();
    const describe = (el: Element) => {
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${text ? ` «${text}»` : ''}`;
    };
    const visible = (el: Element) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden';
    };
    const nameOf = (el: Element) =>
      (el.getAttribute('aria-label') ?? '').trim() ||
      (el.getAttribute('aria-labelledby')
        ? el
            .getAttribute('aria-labelledby')!
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim()
        : '') ||
      (el.getAttribute('title') ?? '').trim();

    if (document.documentElement.lang !== 'it') problems.add('lingua della pagina non «it»');
    const h1 = document.querySelectorAll('main h1');
    if (h1.length !== 1) problems.add(`titoli principali (h1): ${h1.length}`);

    for (const el of document.querySelectorAll('input, select, textarea')) {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden' || !visible(el)) continue;
      if ((input.labels?.length ?? 0) === 0 && !nameOf(el)) {
        problems.add(`campo senza etichetta: ${describe(el)} [${input.type || el.tagName}]`);
      }
    }
    for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
      if (!visible(el)) continue;
      const text =
        (el.textContent ?? '').trim() ||
        nameOf(el) ||
        el.querySelector('img[alt]')?.getAttribute('alt');
      if (!text) problems.add(`comando senza nome: ${describe(el)}`);
    }
    for (const img of document.querySelectorAll('img')) {
      if (!img.hasAttribute('alt')) problems.add(`immagine senza testo alternativo: ${img.src}`);
    }

    // Contrast of the text against the first opaque background behind it.
    const rgb = (value: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) return null;
      const [r, g, b, a = '1'] = m[1]!.split(/[,\s/]+/).filter(Boolean);
      return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
    };
    const luminance = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const background = (el: Element | null): { r: number; g: number; b: number } => {
      for (let node = el; node; node = node.parentElement) {
        const c = rgb(getComputedStyle(node).backgroundColor);
        if (c && c.a > 0.5) return c;
      }
      return { r: 255, g: 255, b: 255 };
    };
    for (const el of document.querySelectorAll('main *, header *, nav *')) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
      if (!own || !visible(el)) continue;
      const style = getComputedStyle(el);
      const fg = rgb(style.color);
      if (!fg) continue;
      const bg = background(el);
      const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        problems.add(
          `contrasto ${ratio.toFixed(2)}: ${describe(el)} (${style.color} su rgb(${bg.r}, ${bg.g}, ${bg.b}))`,
        );
      }
    }
    return [...problems];
  });
}
