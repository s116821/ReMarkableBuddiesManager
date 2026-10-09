import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WiredObserver } from './observer.mjs';

// The host starts this helper explicitly; it serves the built UI on one loopback origin.
export async function startHelper({ root, observer = new WiredObserver() }) {
  const token = randomBytes(32).toString('hex');
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const refuse = code => { res.writeHead(code).end(); };
    if (req.headers.host !== new URL(origin).host) return refuse(403);
    const url = new URL(req.url, origin);
    if (url.pathname === '/manager-host') {
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' ||
          req.headers.cookie !== `manager_session=${token}`) return refuse(403);
      let body = '', bytes = 0;
      try {
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 64) return refuse(413); body += chunk; }
      } catch { return refuse(400); }
      let value;
      try { value = JSON.parse(body); } catch { return refuse(400); }
      if (!value || typeof value !== 'object' || Object.keys(value).join() !== 'action' || !['identity', 'observe', 'cancel'].includes(value.action)) return refuse(400);
      res.setHeader('Content-Type', 'application/json');
      const output = value.action === 'identity' ? { contract_version: 1, kind: 'browser', transport: 'wired-read-only' } :
        value.action === 'cancel' ? observer.cancel() : await observer.observe();
      res.end(JSON.stringify(output)); return;
    }
    if (req.method !== 'GET' || !url.pathname.startsWith('/preview/')) return refuse(404);
    try {
      const relative = decodeURIComponent(url.pathname.slice('/preview/'.length)) || 'index.html';
      const file = path.resolve(root, relative);
      if (!file.startsWith(path.resolve(root) + path.sep) || !['.html', '.js', '.css', '.ico'].includes(path.extname(file))) return refuse(404);
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' })[path.extname(file)]);
      if (relative === 'index.html') res.setHeader('Set-Cookie', `manager_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.end(await readFile(file));
    } catch { refuse(404); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, server, close: async () => { observer.cancel(); await new Promise(resolve => server.close(resolve)); } };
}
