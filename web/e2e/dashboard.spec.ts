/**
 * FE5: the main paths of the dashboard in a real browser, on a computer and on a phone.
 *
 * Login codes are limited to 5 per email per hour, so the tests of a device run in order on one
 * page and log in once; the consultant logs in last.
 */
import { expect, test, type Page } from '@playwright/test';

import {
  accessibilityProblems,
  CONSULTANT,
  focusPageStart,
  keyboardFocusProblems,
  login,
  openSection,
  unique,
} from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;

/** Pages added after the first checks: requests, usage, assistant activity. */
const MORE_PAGES = ['richieste', 'attivita/consumi', 'attivita/assistente'];

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext(testInfo.project.use);
  page = await context.newPage();
  await login(page);
});

test.afterAll(async () => {
  await page.context().close();
});

/** Creates a practice from the dashboard and stays on its page. */
async function createPractice(name: string) {
  await openSection(page, 'Pratiche');
  // The button of the page (the sidebar has its own «Nuova pratica» too).
  await page.locator('#contenuto').getByRole('link', { name: 'Nuova pratica' }).click();
  await page.getByLabel('Nome').fill(name);
  await page.getByRole('button', { name: 'Crea pratica' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('logs in with the code and shows the home with its indicators', async () => {
  await expect(page.getByRole('heading', { level: 1, name: 'Azienda E2E' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Indicatori' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ultime pratiche' })).toBeVisible();
});

test('creates a practice, finds it, opens it and validates it', async () => {
  const name = unique('Vendemmia');
  await createPractice(name);

  await openSection(page, 'Pratiche');
  await page.getByRole('searchbox', { name: 'Cerca' }).fill(name);
  await page.getByRole('button', { name: 'Cerca' }).click();
  await page.getByRole('link', { name }).click();
  await page.getByRole('button', { name: 'Valida' }).click();
  await page.getByRole('button', { name: 'Conferma' }).click();
  await expect(page.getByText('Validata', { exact: true }).first()).toBeVisible();
});

test('assigns a practice on the board and moves it after a confirmation', async () => {
  const name = unique('Potatura');
  await createPractice(name);

  await openSection(page, 'Bacheca');
  const created = page.getByRole('region', { name: /^Creata/ });
  const card = created.getByRole('listitem').filter({ has: page.getByRole('link', { name }) });
  await card.getByRole('combobox', { name: `Assegna «${name}»` }).selectOption({
    label: 'e2e.operatore@sinfonia.test',
  });
  await expect(card.getByRole('combobox', { name: `Assegna «${name}»` })).not.toHaveValue('');
  await card.getByRole('button', { name: 'Valida' }).click();
  await card.getByRole('button', { name: 'Conferma' }).click();
  const validated = page.getByRole('region', { name: /^Validata/ });
  await expect(validated.getByRole('link', { name })).toBeVisible();
  await expect(validated.getByRole('combobox', { name: `Assegna «${name}»` })).not.toHaveValue('');
});

test('reaches the content from the keyboard with «Vai al contenuto»', async ({ isMobile }) => {
  test.skip(isMobile, 'keyboard path');
  await page.goto('./');
  await expect(page.getByRole('list', { name: 'Indicatori' })).toBeVisible();
  await focusPageStart(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Vai al contenuto' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#contenuto')).toBeFocused();
});

test('fits the screen without horizontal scrolling on every main page', async () => {
  for (const path of [
    '',
    'pratiche',
    'bacheca',
    'scadenze',
    'verifica',
    'deleghe',
    'impostazioni',
    'persone',
    'attivita',
    'assistenza',
    'export',
    'profilo',
    'pratiche/nuova',
    ...MORE_PAGES,
  ]) {
    await page.goto(`./${path}`);
    await expect(page.locator('main h1')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path || 'home').toBeLessThanOrEqual(0);
  }
  // Space for the scrollbar is always kept, so header and content keep their place between short
  // and long sections (the test browser's scrollbars take no space, so it is checked directly).
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter),
  ).toBe('stable');
});

test('meets the basic accessibility checks on every main page', async () => {
  const found: Record<string, string[]> = {};
  for (const path of [
    '',
    'pratiche',
    'pratiche/nuova',
    'bacheca',
    'scadenze',
    'verifica',
    'deleghe',
    'persone',
    'attivita',
    'assistenza',
    'export',
    'impostazioni',
    'profilo',
    ...MORE_PAGES,
  ]) {
    await page.goto(`./${path}`);
    await expect(page.locator('main h1')).toBeVisible();
    const problems = await accessibilityProblems(page);
    if (problems.length > 0) found[path || 'home'] = problems;
  }
  expect(found).toEqual({});
});

test('the pages of a practice and of a person fit the screen and pass the checks', async () => {
  const name = unique('Semina');
  await createPractice(name);
  const practicePage = page.url();
  await openSection(page, 'Persone');
  await page.getByRole('link', { name: 'e2e.operatore@sinfonia.test' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'e2e.operatore@sinfonia.test' }),
  ).toBeVisible();
  const memberPage = page.url();

  const found: Record<string, string[]> = {};
  for (const [label, url] of [
    ['pratica', practicePage],
    ['persona', memberPage],
  ] as const) {
    await page.goto(url);
    await expect(page.locator('main h1')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, label).toBeLessThanOrEqual(0);
    const problems = await accessibilityProblems(page);
    if (problems.length > 0) found[label] = problems;
  }
  expect(found).toEqual({});
});

test('shows where the keyboard is on every main page', async ({ isMobile }) => {
  test.skip(isMobile, 'keyboard path');
  const found: Record<string, string[]> = {};
  for (const path of [
    '',
    'pratiche',
    'pratiche/nuova',
    'bacheca',
    'deleghe',
    'persone',
    'export',
  ]) {
    await page.goto(`./${path}`);
    await expect(page.locator('main h1')).toBeVisible();
    const problems = await keyboardFocusProblems(page);
    if (problems.length > 0) found[path || 'home'] = problems;
  }
  expect(found).toEqual({});
});

test('takes a request for assistance and closes it', async () => {
  await openSection(page, 'Assistenza');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Richieste di assistenza' }),
  ).toBeVisible();
  const card = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Prendi in carico' }) })
    .first();
  await card.getByRole('button', { name: 'Prendi in carico' }).click();
  await expect(page.getByRole('status')).toHaveText(/presa in carico/);
  const taken = page
    .getByRole('listitem')
    .filter({ hasText: 'In carico dal' })
    .filter({ has: page.getByRole('button', { name: 'Chiudi' }) })
    .first();
  await taken.getByRole('button', { name: 'Chiudi' }).click();
  await expect(page.getByRole('status')).toHaveText(/Richiesta chiusa/);
  await page.getByRole('button', { name: 'Chiuse' }).click();
  await expect(page.getByText(/^Chiusa il /).first()).toBeVisible();
});

test('gives a delegation to a consultant and revokes it', async () => {
  await openSection(page, 'Deleghe');
  await page.getByLabel('A una persona (es. un consulente), con la sua email').check();
  await page.getByLabel('Email della persona').fill(CONSULTANT);
  await page.getByRole('button', { name: 'Concedi la delega' }).click();
  await expect(page.getByRole('status')).toHaveText('Delega concessa.');
  const grant = page
    .getByRole('listitem')
    .filter({ hasText: CONSULTANT })
    .filter({ hasText: 'attiva' })
    .first();
  await grant.getByRole('button', { name: 'Revoca' }).click();
  await expect(page.getByRole('status')).toContainText('Delega revocata');
});

test('the consultant opens the practices of the company through a new delegation', async () => {
  await openSection(page, 'Deleghe');
  await page.getByLabel('A una persona (es. un consulente), con la sua email').check();
  await page.getByLabel('Email della persona').fill(CONSULTANT);
  await page.getByRole('button', { name: 'Concedi la delega' }).click();
  await expect(page.getByRole('status')).toHaveText('Delega concessa.');

  await page.context().clearCookies();
  await login(page, CONSULTANT);
  await openSection(page, 'Deleghe');
  await page.getByRole('button', { name: 'Ricevute' }).click();
  await page.getByRole('link', { name: 'Apri le pratiche di Azienda E2E' }).first().click();
  await expect(page.getByText(/Stai lavorando sui dati di/)).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Pratiche di Azienda E2E' }),
  ).toBeVisible();
});
