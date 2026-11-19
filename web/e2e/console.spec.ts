/**
 * FE5 (item 31): the platform console in a real browser, on a computer and on a phone. The
 * administrator of the test platform (scripts/e2e/server.ts) logs in, chooses the console and
 * goes through its sections; every page must fit the screen and pass the accessibility checks.
 */
import { expect, test, type Page } from '@playwright/test';

import {
  accessibilityProblems,
  enterCode,
  focusPageStart,
  openSection,
  PLATFORM_ADMIN,
} from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext(testInfo.project.use);
  page = await context.newPage();
  await enterCode(page, PLATFORM_ADMIN);
});

test.afterAll(async () => {
  await page.context().close();
});

const SECTIONS = [
  ['Organizzazioni', 'Organizzazioni'],
  ['Registro', 'Registro della piattaforma'],
  ['Salute', 'Salute del sistema'],
  ['Consumi IA', 'Consumi IA'],
  ['Consumi', 'Consumi'],
] as const;

test('chooses the console after the login and lists the organizations', async () => {
  await page.getByRole('button', { name: /Console di piattaforma/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organizzazioni' })).toBeVisible();
  // The test database holds many organizations: the search finds the one of the tests.
  await page.getByRole('searchbox', { name: 'Cerca' }).fill('Azienda E2E');
  await expect(page.getByRole('link', { name: 'Azienda E2E' }).first()).toBeVisible();
});

test('reaches the content of the console from the keyboard with «Vai al contenuto»', async ({
  isMobile,
}) => {
  test.skip(isMobile, 'keyboard path');
  await focusPageStart(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Vai al contenuto' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#contenuto')).toBeFocused();
});

test('goes through every section of the console, which fits the screen and passes the checks', async () => {
  const found: Record<string, string[]> = {};
  for (const [link, heading] of SECTIONS) {
    await openSection(page, link, 'Sezioni della console');
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, link).toBeLessThanOrEqual(0);
    const problems = await accessibilityProblems(page);
    if (problems.length > 0) found[link] = problems;
  }
  expect(found).toEqual({});
});

test('opens the page of an organization', async () => {
  await openSection(page, 'Organizzazioni', 'Sezioni della console');
  await page.getByRole('searchbox', { name: 'Cerca' }).fill('Azienda E2E');
  await page.getByRole('link', { name: 'Azienda E2E' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Azienda E2E' })).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);
});
