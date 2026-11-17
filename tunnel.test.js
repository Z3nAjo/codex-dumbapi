import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTunnel } from './tunnel.js';

test('tunnel settings, argument substitution, process lifecycle and startup errors', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dummy-tunnel-'));
  const settingsFile = path.join(directory, 'tunnel.json');
  const defaults = { provider: 'custom', command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1))); setInterval(() => {}, 1000)', '{port}', '{localUrl}', '{publicUrl}', 'literal;echo hello'], publicUrl: 'https://example.com' };
  const tunnel = await createTunnel({ defaults, settingsFile });
  try {
    await tunnel.save(defaults);
    const reloaded = await createTunnel({ defaults: { ...defaults, args: [] }, settingsFile });
    assert.deepEqual(reloaded.status().config, defaults);
    await tunnel.start(12345);
    assert.equal(tunnel.status().state, 'running');
    await assert.rejects(tunnel.start(12345), /already started/);
    await assert.rejects(tunnel.save(defaults), /Stop the tunnel/);
    for (let i = 0; i < 50 && !tunnel.status().output; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(JSON.parse(tunnel.status().output), ['12345', 'http://127.0.0.1:12345', 'https://example.com', 'literal;echo hello']);
    await tunnel.stop();
    assert.equal(tunnel.status().state, 'stopped');
    await assert.rejects(tunnel.save({ ...defaults, args: 'shell command' }), /argument array/);
    await assert.rejects(tunnel.save({ ...defaults, publicUrl: 'javascript:alert(1)' }), /HTTP or HTTPS/);
    await tunnel.save({ ...defaults, command: path.join(directory, 'missing-tool') });
    await assert.rejects(tunnel.start(12345), /Cannot start/);
    assert.equal(tunnel.status().state, 'error');
    await tunnel.save({ ...defaults, publicUrl: '', args: ['-e', 'console.log("https://example-test.trycloudflare.com"); setInterval(() => {}, 1000)'] });
    await tunnel.start(12345);
    for (let i = 0; i < 50 && !tunnel.status().publicUrl; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(tunnel.status().publicUrl, 'https://example-test.trycloudflare.com');
  } finally {
    await tunnel.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
