/**
 * Cantiere 3 (item 45): the dashboard can be installed on a phone. The manifest declares the
 * app, the service worker takes control of /app/ and keeps only the dashboard's own files: never
 * an answer of the API.
 */
import { expect, test } from '@playwright/test';

test('declares the app and installs a worker that keeps no data', async ({ page }) => {
  await page.goto('/app/');
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    return link ? ((await (await fetch(link.href)).json()) as Record<string, unknown>) : null;
  });
  expect(manifest).toMatchObject({
    name: 'SinfonIA',
    start_url: '/app/',
    scope: '/app/',
    display: 'standalone',
  });
  expect((manifest?.icons as Array<{ sizes: string }>).map((i) => i.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512']),
  );

  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe('/app/');

  // An API call goes through, and nothing outside /app/ ends up in the cache.
  await page.evaluate(() => fetch('/readyz').then((r) => r.status));
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const key of await caches.keys()) {
      for (const request of await (await caches.open(key)).keys()) urls.push(request.url);
    }
    return urls.map((u) => new URL(u).pathname);
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.every((p) => p.startsWith('/app/'))).toBe(true);
});
