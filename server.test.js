import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

test('route lifecycle, static responses, persistence, and admin isolation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dummy-api-'));
  process.env.ROUTES_DIR = directory;
  process.env.LOG_DIR = path.join(directory, 'logs');
  process.env.TUNNEL_SETTINGS_FILE = path.join(directory, 'tunnel.json');
  const { server } = await import('./server.js');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, options) => fetch(base + url, options);
  const save = (response, method = 'POST') => call('/admin/routes/example', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, response }) });
  try {
    assert.equal((await call('/')).status, 200);
    assert.equal((await call('/admin/tunnel')).status, 200);
    assert.equal((await call('/admin/tunnel/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    assert.equal((await call('/admin/tunnel/start', { method: 'POST' })).status, 415);
    const externalStatus = await new Promise((resolve, reject) => {
      http.get(base + '/admin/routes', { headers: { Host: 'wreath-resale-scoundrel.ngrok-free.dev' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(externalStatus, 403);
    const payload = { items: [1, 2], ok: true };
    assert.equal((await save(payload)).status, 200);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'example.json'), 'utf8')).response, payload);
    assert.equal((await call('/api/example')).status, 405);
    const response = await call('/api/example?ignored=1', { method: 'POST', body: 'not even json', headers: { Host: 'wreath-resale-scoundrel.ngrok-free.dev' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), payload);
    for (const value of [null, false, 0, 'hello', [1, 2]]) {
      await save(value);
      assert.deepEqual(await (await call('/api/example', { method: 'POST' })).json(), value);
    }
    await writeFile(path.join(directory, 'example.json'), JSON.stringify({ name: 'example', method: 'GET', response: { changed: true } }));
    assert.deepEqual(await (await call('/api/example')).json(), { changed: true });
    assert.equal((await call('/api/example', { method: 'OPTIONS' })).status, 204);
    for (const method of ['PUT', 'DELETE']) {
      assert.equal((await save(payload, method)).status, 200);
      assert.deepEqual(await (await call('/api/example', { method, body: 'ignored' })).json(), payload);
      assert.equal((await call('/api/example')).status, 405);
    }
    assert.equal((await save(payload, 'ALL')).status, 200);
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await call('/api/example', { method });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), payload);
    }
    const head = await call('/api/example', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const preflight = await call('/api/example', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'PUT', Origin: 'https://example.com' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'PUT');
    const logging = enabled => call('/admin/logs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    assert.deepEqual((await (await call('/admin/logs')).json()).entries, []);
    assert.equal((await (await logging(true)).json()).enabled, true);
    const loggedResponse = await call('/api/example?source=test', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"incoming":true}' });
    assert.deepEqual(await loggedResponse.json(), payload);
    let recorded;
    for (let attempt = 0; attempt < 20; attempt++) {
      recorded = await (await call('/admin/logs')).json();
      if (recorded.entries.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(recorded.entries.length, 1);
    const entry = recorded.entries[0];
    assert.equal(entry.request.url, '/api/example?source=test');
    assert.equal(entry.request.method, 'PUT');
    assert.equal(entry.request.body, '{"incoming":true}');
    assert.equal(entry.response.status, 200);
    assert.deepEqual(JSON.parse(entry.response.body), payload);
    assert.equal(entry.response.headers['Content-Type'], 'application/json; charset=utf-8');
    const downloaded = await (await call('/admin/logs/download')).text();
    assert.deepEqual(JSON.parse(downloaded), entry);
    const { createLogger } = await import('./logging.js');
    const reloaded = await createLogger(process.env.LOG_DIR);
    assert.equal((await reloaded.status()).enabled, true);
    assert.deepEqual((await reloaded.status()).entries[0], entry);
    await logging(false);
    await (await call('/api/example')).text();
    assert.equal((await (await call('/admin/logs')).json()).entries.length, 1);
    assert.equal((await call('/admin/logs', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{"enabled":true}' })).status, 403);
    const cleared = await (await call('/admin/logs', { method: 'DELETE' })).json();
    assert.deepEqual(cleared.entries, []);
    assert.equal(await readFile(path.join(directory, 'logs/requests.jsonl'), 'utf8'), '');
    assert.equal((await call('/admin/routes/example', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    assert.equal((await call('/admin/routes/example', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
    assert.equal((await call('/admin/routes/%2e%2e%2fescape', { method: 'DELETE' })).status, 400);
    assert.equal((await call('/admin/routes/example', { method: 'DELETE' })).status, 200);
    assert.equal((await call('/api/example')).status, 404);
    const savePath = (name, response, method = 'ALL') => call('/admin/routes/' + encodeURIComponent(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, response }) });
    const pattern = 'users/{name}/orders/{id}';
    assert.equal((await savePath(pattern, { name: '{name}', id: '{id}', nested: ['Hello {name}', { number: 12, flag: true, missing: '{unknown}' }] })).status, 200);
    assert((await (await call('/admin/routes')).json()).some(route => route.name === pattern));
    const rendered = await (await call('/api/users/A%20B/orders/001?name=ignored&id=99', { method: 'POST', body: 'ignored' })).json();
    assert.deepEqual(rendered, { name: 'A B', id: '001', nested: ['Hello A B', { number: 12, flag: true, missing: '{unknown}' }] });
    assert.equal((await call('/api/users/A/orders')).status, 404);
    assert.equal((await savePath('users/{other}/orders/{key}', {})).status, 409);
    assert.equal((await savePath('users/{name}/{name}', {})).status, 400);
    assert.equal((await savePath('users/fixed/orders/{id}', { literal: true, id: '{id}' })).status, 200);
    assert.deepEqual(await (await call('/api/users/fixed/orders/2')).json(), { literal: true, id: '2' });
    assert.equal((await savePath('1', { exact: true })).status, 200);
    assert.equal((await savePath('{value}', { value: '{value}' })).status, 200);
    assert.deepEqual(await (await call('/api/1?prop=a')).json(), { exact: true });
    assert.deepEqual(await (await call('/api/false?prop=a')).json(), { value: 'false' });
    const tricky = 'quotes"\\/{id}';
    const trickyResponse = await (await call('/api/' + encodeURIComponent(tricky))).json();
    assert.deepEqual(trickyResponse, { value: tricky });
    assert.equal((await call('/api/%ZZ')).status, 400);
    assert.equal((await call('/admin/routes/' + encodeURIComponent(pattern), { method: 'DELETE' })).status, 200);
    assert.equal((await call('/api/users/A/orders/1')).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
