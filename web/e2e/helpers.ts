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
