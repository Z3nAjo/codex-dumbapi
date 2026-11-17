import { promises as fs } from 'node:fs';
import path from 'node:path';

const limit = 1024 * 1024;
export async function createLogger(directory) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'requests.jsonl');
  const settingsFile = path.join(directory, 'logging.json');
  let enabled = false, entries = [], pending = Promise.resolve(), error = null, generation = 0;
  try { enabled = JSON.parse(await fs.readFile(settingsFile, 'utf8')).enabled === true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Load only the tail for the viewer; the complete history remains in the file.
  const handle = await fs.open(file, 'a+');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - 4 * limit);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start) lines.shift();
    entries = lines.filter(Boolean).slice(-100).map(line => JSON.parse(line));
  } finally { await handle.close(); }
  function queue(action) {
    const operation = pending.then(action);
    pending = operation.catch(e => { error = e.message; console.error('Logging:', e.message); });
    return operation;
  }
  function capture(req, res) {
    if (!enabled) return;
    const epoch = generation, started = Date.now(), chunks = [], responseChunks = [];
    let bytes = 0, responseBytes = 0;
    const append = (list, chunk, encoding, total) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
      if (total < limit) list.push(buffer.subarray(0, limit - total));
      return buffer.length;
    };
    req.on('data', chunk => { bytes += append(chunks, chunk, undefined, bytes); });
    const ended = new Promise(resolve => { req.once('end', resolve); req.once('aborted', resolve); req.once('error', resolve); });
    const write = res.write, end = res.end, writeHead = res.writeHead;
    let responseHeaders = {};
    res.writeHead = function(status, reason, headers) {
      responseHeaders = { ...res.getHeaders(), ...(typeof reason === 'object' ? reason : headers) };
      return writeHead.apply(this, arguments);
    };
    res.write = function(chunk, encoding, callback) { if (chunk != null) responseBytes += append(responseChunks, chunk, encoding, responseBytes); return write.call(this, chunk, encoding, callback); };
    res.end = function(chunk, encoding, callback) { if (chunk != null && typeof chunk !== 'function') responseBytes += append(responseChunks, chunk, encoding, responseBytes); return end.call(this, chunk, encoding, callback); };
    res.once('finish', async () => {
      await ended;
      const entry = {
        id: crypto.randomUUID(), timestamp: new Date(started).toISOString(), durationMs: Date.now() - started,
        request: { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), bytes, truncated: bytes > limit },
        response: { status: res.statusCode, headers: responseHeaders, body: req.method === 'HEAD' ? '' : Buffer.concat(responseChunks).toString('utf8'), bytes: req.method === 'HEAD' ? 0 : responseBytes, truncated: req.method !== 'HEAD' && responseBytes > limit }
      };
      await queue(async () => {
        if (epoch !== generation) return;
        await fs.appendFile(file, JSON.stringify(entry) + '\n');
        entries.push(entry); entries = entries.slice(-100); error = null;
      }).catch(() => {});
    });
    req.resume();
  }
  return {
    file, capture,
    async status() { await pending; return { enabled, entries: [...entries].reverse(), error }; },
    async setEnabled(value) { await queue(async () => { await fs.writeFile(settingsFile, JSON.stringify({ enabled: value }, null, 2) + '\n'); enabled = value; error = null; }); },
    async clear() { generation++; await queue(async () => { await fs.writeFile(file, ''); entries = []; error = null; }); }
  };
}
