import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function createTunnel({ defaults, settingsFile }) {
  let config = defaults;
  try { config = JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let child = null, state = 'stopped', output = '', lastError = null, detectedUrl = '', stopping = false;
  function validate(value) {
    if (!value || !['ngrok', 'cloudflared', 'custom'].includes(value.provider) || typeof value.command !== 'string' || !value.command.trim() || value.command.length > 1024 || !Array.isArray(value.args) || value.args.length > 100 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4096) || typeof value.publicUrl !== 'string') throw Object.assign(new Error('Choose a provider, executable, argument array, and public URL (or leave the URL empty).'), { status: 400 });
    if (value.publicUrl) {
      let url;
      try { url = new URL(value.publicUrl); } catch { throw Object.assign(new Error('Public URL must be a valid HTTP or HTTPS URL.'), { status: 400 }); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Object.assign(new Error('Use an HTTP or HTTPS origin without credentials, path, query, or fragment.'), { status: 400 });
    }
    return { provider: value.provider, command: value.command.trim(), args: value.args, publicUrl: value.publicUrl.replace(/\/$/, '') };
  }
  config = validate(config);
  return {
    status() { return { config, state, output, error: lastError, publicUrl: config.publicUrl || detectedUrl }; },
    async save(value) {
      if (child) throw Object.assign(new Error('Stop the tunnel before changing settings.'), { status: 409 });
      const next = validate(value);
      await fs.mkdir(path.dirname(settingsFile), { recursive: true });
      const temporary = `${settingsFile}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n');
      await fs.rename(temporary, settingsFile);
      config = next; detectedUrl = ''; lastError = null;
    },
    async start(port) {
      if (child) throw Object.assign(new Error('Tunnel is already started.'), { status: 409 });
      const replace = value => value.replace(/\{(port|localUrl|publicUrl)\}/g, (_, key) => ({ port: String(port), localUrl: `http://127.0.0.1:${port}`, publicUrl: config.publicUrl })[key]);
      output = ''; lastError = null; detectedUrl = ''; stopping = false; state = 'starting';
      const args = config.args.filter((arg, index, args) => !(config.provider === 'ngrok' && !config.publicUrl && (arg === '--url' && args[index + 1] === '{publicUrl}' || arg === '{publicUrl}' && args[index - 1] === '--url')));
      const process = spawn(config.command, args.map(replace), { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child = process;
      const append = chunk => {
        output = (output + chunk.toString()).slice(-16000);
        const urls = output.match(/https:\/\/[a-z0-9.-]+\.(?:trycloudflare\.com|ngrok-free\.app|ngrok-free\.dev|ngrok\.io)/gi);
        if (urls?.length) detectedUrl = urls.at(-1);
      };
      process.stdout.on('data', append); process.stderr.on('data', append);
      process.on('close', code => {
        if (child !== process) return;
        child = null; state = stopping || code === 0 ? 'stopped' : 'error';
        if (state === 'error' && !lastError) lastError = `Tunnel exited with code ${code}. Check output below.`;
      });
      await new Promise((resolve, reject) => {
        process.once('spawn', () => { state = 'running'; resolve(); });
        process.once('error', error => {
          lastError = `Cannot start ${config.command}: ${error.message}`; state = 'error'; child = null;
          reject(Object.assign(new Error(lastError), { status: 400 }));
        });
      });
    },
    async stop() {
      if (!child) return;
      const process = child; stopping = true; state = 'stopping';
      await new Promise(resolve => {
        const timeout = setTimeout(() => process.kill('SIGKILL'), 3000);
        process.once('close', () => { clearTimeout(timeout); resolve(); });
        process.kill('SIGTERM');
      });
    }
  };
}
