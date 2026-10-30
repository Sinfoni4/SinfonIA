import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type WebRoutesDeps = {
  /** Folder of the built dashboard (Vite output, built with base `/app/`). */
  distDir: string;
};

/** Where the dashboard lives: same origin as the API (B2), so no CORS and the cookie works. */
export const WEB_BASE = '/app';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the built dashboard under /app (public: the page itself holds no data, every call to the
 * API is authenticated). Unknown paths without an extension get index.html (client-side routes);
 * hashed assets are cached for a year, index.html never.
 */
export const webRoutes: FastifyPluginCallback<WebRoutesDeps> = (app, deps, done) => {
  const root = path.resolve(deps.distDir);
  const index = path.join(root, 'index.html');

  const serve = async (rel: string) => {
    const decoded = decodeURIComponent(rel.split('?')[0] ?? '');
    const target = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
    // Never outside the dashboard folder.
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    if (await isFile(target)) return target;
    return path.extname(decoded) ? null : index;
  };

  const handler = async (req: { url: string }, reply: FastifyReply): Promise<unknown> => {
    const rel = req.url.slice(WEB_BASE.length).replace(/^\/+/, '');
    const file = await serve(rel);
    if (!file || !(await isFile(file))) {
      return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    }
    const hashedAsset = rel.startsWith('assets/');
    return reply
      .header('cache-control', hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .type(TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
      .send(await readFile(file));
  };

  app.get(WEB_BASE, (_req, reply) => reply.redirect(`${WEB_BASE}/`));
  app.get(`${WEB_BASE}/*`, handler);
  done();
};
