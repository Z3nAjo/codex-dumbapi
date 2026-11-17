import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { createLogger } from './logging.js';
import { createHash } from 'node:crypto';
import { validRoute, matchRoute, renderResponse } from './routing.js';
import { createTunnel } from './tunnel.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const routeDir = process.env.ROUTES_DIR || path.join(root, 'routes');
await fs.mkdir(routeDir, { recursive: true });
const logger = await createLogger(process.env.LOG_DIR || path.join(root, 'data'));
const tunnel = await createTunnel({ defaults: JSON.parse(await fs.readFile(path.join(root, 'tunnel.config.json'), 'utf8')), settingsFile: process.env.TUNNEL_SETTINGS_FILE || path.join(root, 'data/tunnel.json') });

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024) throw Object.assign(new Error('Configuration must be smaller than 1 MB.'), { status: 413 });
  }
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function routeFile(name) {
  const filename = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name) ? name : `pattern.${createHash('sha256').update(name).digest('hex')}`;
  return path.join(routeDir, `${filename}.json`);
}
async function listRoutes() {
  const files = (await fs.readdir(routeDir)).filter(f => f.endsWith('.json')).sort();
  const configs = await Promise.all(files.map(async f => JSON.parse(await fs.readFile(path.join(routeDir, f), 'utf8'))));
  return configs.filter(config => config && validRoute(config.name));
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      logger.capture(req, res);
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': req.headers['access-control-request-method'] || 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, ngrok-skip-browser-warning' };
      if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) { res.writeHead(204, cors); return res.end(); }
      const matched = matchRoute(await listRoutes(), pathname.slice(5));
      if (!matched) return json(res, 404, { error: 'Route not found.' }, cors);
      const { config, params } = matched;
      if (req.method === 'OPTIONS' && config.method !== 'ALL') { res.writeHead(204, cors); return res.end(); }
      if (config.method !== 'ALL' && req.method !== config.method) return json(res, 405, { error: `Use ${config.method} for this route.` }, { ...cors, Allow: config.method });
      // Request bodies and query parameters deliberately do not affect the response.
      req.resume();
      return json(res, 200, renderResponse(config.response, params), cors);
    }
    // Configuration controls stay on localhost; ngrok exposes only the dummy API.
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return json(res, 403, { error: 'Open the admin panel using the local server URL.' });
    if (pathname === '/admin/tunnel' || pathname === '/admin/tunnel/start' || pathname === '/admin/tunnel/stop') {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Invalid origin.' });
      if (pathname === '/admin/tunnel' && req.method === 'GET') return json(res, 200, tunnel.status());
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
      if (pathname === '/admin/tunnel' && req.method === 'PUT') await tunnel.save(await readBody(req));
      else if (pathname === '/admin/tunnel/start' && req.method === 'POST') await tunnel.start(server.address().port);
      else if (pathname === '/admin/tunnel/stop' && req.method === 'POST') await tunnel.stop();
      else return json(res, 405, { error: 'Method not allowed.' });
      return json(res, 200, tunnel.status());
    }
    if (pathname === '/admin/logs' || pathname === '/admin/logs/download') {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Invalid origin.' });
      if (pathname === '/admin/logs/download' && req.method === 'GET') {
        await logger.status();
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="requests.jsonl"', 'Cache-Control': 'no-store' });
        const stream = createReadStream(logger.file);
        stream.on('error', () => res.destroy());
        return stream.pipe(res);
      }
      if (pathname !== '/admin/logs') return json(res, 405, { error: 'Method not allowed.' });
      if (req.method === 'PUT') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
        const body = await readBody(req);
        if (typeof body?.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be true or false.' });
        await logger.setEnabled(body.enabled);
      } else if (req.method === 'DELETE') await logger.clear();
      else if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
      return json(res, 200, await logger.status());
    }
    if (pathname.startsWith('/admin/routes')) {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Invalid origin.' });
      if (pathname === '/admin/routes' && req.method === 'GET') {
        return json(res, 200, await listRoutes());
      }
      let name;
      try { name = decodeURIComponent(pathname.slice('/admin/routes/'.length)); } catch { return json(res, 400, { error: 'Invalid route encoding.' }); }
      if (!pathname.startsWith('/admin/routes/') || !validRoute(name)) return json(res, 400, { error: 'Use path segments such as users/{name}. Parameter names must be unique; maximum path length is 240 characters.' });
      if (req.method === 'PUT') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
        const config = await readBody(req);
        if (!config || !['GET', 'POST', 'PUT', 'DELETE', 'ALL'].includes(config.method) || !Object.hasOwn(config, 'response')) return json(res, 400, { error: 'A GET, POST, PUT, DELETE, or ALL method and a JSON response are required.' });
        const saved = { name, method: config.method, response: config.response };
        const shape = value => value.split('/').map(segment => segment.startsWith('{') ? '{}' : segment).join('/');
        if ((await listRoutes()).some(route => route.name !== name && shape(route.name) === shape(name))) return json(res, 409, { error: 'A route with the same path pattern already exists.' });
        const destination = routeFile(name);
        const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(saved, null, 2) + '\n');
        await fs.rename(temporary, destination);
        return json(res, 200, saved);
      }
      if (req.method === 'DELETE') {
        await fs.unlink(routeFile(name));
        return json(res, 200, { deleted: name });
      }
      return json(res, 405, { error: 'Method not allowed.' });
    }
    if ((pathname === '/' || pathname === '/admin') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(await fs.readFile(path.join(root, 'public/index.html')));
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (res.headersSent) return res.end();
    json(res, error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : error.code === 'ENOENT' ? 'Route not found.' : 'Could not read or save route configuration.' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const preferredPort = Number(process.env.PORT || 80);
  server.once('error', error => {
    if (!process.env.PORT && ['EADDRINUSE', 'EACCES'].includes(error.code)) server.listen(0, '127.0.0.1');
    else { console.error(error.message); process.exitCode = 1; }
  });
  server.on('listening', () => {
    const port = server.address().port;
    console.log(`Admin panel: http://localhost:${port}`);
    console.log('Configure and start a tunnel from the admin panel.');
  });
  server.listen(preferredPort, '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await tunnel.stop(); server.close(); process.exit(0); });
}
