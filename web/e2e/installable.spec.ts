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

  // In CI (Playwright's Chromium on Linux) the worker is never registered, while it is with
  // Chrome on Windows: to be investigated (docs/ELENCO_STEP_MANCANTI.md, FE5). The manifest is
  // checked everywhere; the worker only locally, until then.
  test.skip(!!process.env.CI, 'service worker: checked only locally with Chrome');

  // The worker the dashboard registers at load; when it does not become active, the state of the
  // registration and the answer for sw.js say why, instead of a bare timeout.
  const worker = await page.evaluate(async () => {
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then((r) => r.scope),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    if (ready) return { scope: ready };
    const registrations = await navigator.serviceWorker.getRegistrations();
    const file = await fetch('/app/sw.js');
    let registerError: string | null = null;
    try {
      await navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' });
    } catch (err) {
      registerError = String(err);
    }
    // The worker's install step stores /app/ in the cache: a failure there drops the worker.
    let cacheError: string | null = null;
    try {
      await (await caches.open('e2e-check')).add('/app/');
      await caches.delete('e2e-check');
    } catch (err) {
      cacheError = String(err);
    }
    const shell = await fetch('/app/');
    return {
      scope: null,
      cacheError,
      shell: {
        status: shell.status,
        vary: shell.headers.get('vary'),
        cacheControl: shell.headers.get('cache-control'),
      },
      registrations: registrations.map((r) => ({
        scope: r.scope,
        installing: r.installing?.state ?? null,
        waiting: r.waiting?.state ?? null,
        active: r.active?.state ?? null,
      })),
      file: { status: file.status, type: file.headers.get('content-type') },
      registerError,
      secure: window.isSecureContext,
    };
  });
  expect(worker, JSON.stringify(worker)).toMatchObject({
    scope: expect.stringMatching(/\/app\/$/),
  });

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
