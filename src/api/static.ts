// Web interface hosting. The API serves the built single-page app (web/) from the same origin,
// so the browser needs no CORS and the bearer token never crosses an origin. Only files that exist
// in the build directory are served; every other GET outside /api/ falls back to index.html (client
// routes). The UI gets its own, strict content security policy; API responses keep `default-src 'none'`.

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

/** Script, style, image and fetch sources limited to this origin; no inline script or style; nothing may frame the app. */
export const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function webDir(): string | null {
  const dir = resolve(process.env.WEB_DIR ?? join(process.cwd(), 'web', 'dist'));
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

export function isUiPath(url: string): boolean {
  const path = url.split('?')[0];
  return !(path.startsWith('/api/') || path === '/healthz' || path === '/readyz' || path === '/metrics');
}

export function registerWeb(app: FastifyInstance, dir: string): void {
  const root = dir.endsWith(sep) ? dir : dir + sep;
  const serve = async (rel: string, rep: import('fastify').FastifyReply) => {
    const file = resolve(root, rel);
    if (!file.startsWith(root)) return false;               // path traversal
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
      const ext = extname(file);
      rep.header('content-type', TYPES[ext] ?? 'application/octet-stream');
      // Hashed build assets are immutable; the shell document must always be revalidated.
      rep.header('cache-control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      rep.send(await readFile(file));
      return true;
    } catch { return false; }
  };
  app.setNotFoundHandler(async (req, rep) => {
    if (req.method === 'GET' && isUiPath(req.url)) {
      const path = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      if (path && extname(path) && await serve(path, rep)) return rep;
      if (!extname(path) && await serve('index.html', rep)) return rep;
    }
    return rep.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
  });
}
