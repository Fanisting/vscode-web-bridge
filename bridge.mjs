#!/usr/bin/env node
// vscode-web-bridge: local relay between an agent (HTTP /rpc) and a VS Code
// web extension running inside code-server / vscode.dev / github.dev / codespaces.
// Zero dependencies. The extension long-polls /ext-api/poll for commands.
//
// Security model
// - Binds 127.0.0.1 and rejects any Host header other than localhost/127.0.0.1:PORT (DNS rebinding).
// - Two secrets: TOKEN (agent API, never leaves this machine) and EXT_TOKEN = HMAC(TOKEN) (baked into
//   the extension / VSIX). EXT_TOKEN cannot call the agent API.
// - /ext-api/* needs EXT_TOKEN and, when the request carries an Origin, an allowed origin
//   (built-ins + ~/.vscode-web-bridge/origins, managed with `vsc allow-origin`). The check is
//   server-side, so cross-site "simple" POSTs are rejected, not just unreadable.
// - The extension is served only under the secret path /ext/<EXT_TOKEN>/.
// - /rpc, /clients, ... need TOKEN and refuse any request carrying an Origin.
// - /ext-api/exec runs only a command the agent itself sent via terminal.run (one-time ticket).
// - Delivery is at-most-once: a request is re-routed only if it was never acknowledged by the
//   receiving client and that client is gone (e.g. tab reloaded mid-delivery).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(HERE, 'extension');
const PORT = Number(process.env.VSCB_PORT || 47821);
const HOST = '127.0.0.1';
const STATE_DIR = path.join(os.homedir(), '.vscode-web-bridge');
const TOKEN_FILE = path.join(STATE_DIR, 'token');
const ORIGINS_FILE = path.join(STATE_DIR, 'origins');

fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(TOKEN_FILE)) {
  fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
}
// owner-only access to the token file
if (process.platform === 'win32') {
  try { execFileSync('icacls', [TOKEN_FILE, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { stdio: 'ignore' }); } catch { }
} else { try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { } }
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const EXT_TOKEN = crypto.createHmac('sha256', TOKEN).update('vscode-web-bridge/ext/v1').digest('hex').slice(0, 48);
const EXT_PREFIX = `/ext/${EXT_TOKEN}/`;
const INSTALL_URL = `http://localhost:${PORT}${EXT_PREFIX}`;
const HOST_RE = new RegExp(`^(localhost|127\\.0\\.0\\.1):${PORT}$`, 'i');

// Origins allowed on /ext-api. The vscode.dev web worker runs on <hash>.vscode-cdn.net;
// code-server usually uses its own origin, which the user adds once with `vsc allow-origin`.
const BUILTIN_ORIGINS = [/^https:\/\/[a-z0-9-]+\.vscode-cdn\.net$/i, /^https:\/\/(insiders\.)?vscode\.dev$/i, /^https:\/\/github\.dev$/i,
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i];
let originsCache = { mtime: -1, list: [] };
function extraOrigins() {
  let m = -1;
  try { m = fs.statSync(ORIGINS_FILE).mtimeMs; } catch { }
  if (m !== originsCache.mtime) {
    let list = [];
    try { list = fs.readFileSync(ORIGINS_FILE, 'utf8').split(/\r?\n/).map(s => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean); } catch { }
    originsCache = { mtime: m, list };
  }
  return originsCache.list;
}
const originAllowed = o => !o || BUILTIN_ORIGINS.some(re => re.test(o)) || extraOrigins().includes(o.toLowerCase());
const rejectedOrigins = new Map(); // origin -> last seen

const clients = new Map(); // id -> { id, name, info, lastSeen, queue: [], waiter: null }
const pending = new Map(); // rpc id -> { resolve, timer, client, wanted, msg, sentAt, acked, rerouted, ticketIds }
const tickets = new Map(); // exec ticket -> { command, cwd, shell, timeout, client }
const log = (...a) => { if (process.env.VSCB_QUIET !== '1') console.log(new Date().toISOString().slice(11, 19), ...a); };

function cors(req, res) {
  const o = req.headers.origin;
  if (o && originAllowed(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// A live client always holds an open long-poll (or re-polled within the last few seconds).
// A reloaded tab drops its poll socket, so it stops counting quickly.
const alive = c => !!c.waiter || Date.now() - c.lastSeen < 5000;
function pickClient(want) {
  const live = [...clients.values()].filter(alive);
  if (want) return live.find(c => c.id === want || c.name === want || (c.name || '').toLowerCase().includes(String(want).toLowerCase()));
  return live.sort((a, b) => b.focusedAt - a.focusedAt || b.connectedAt - a.connectedAt)[0];
}
// forget clients gone for 10 minutes
setInterval(() => { for (const [id, c] of clients) if (!alive(c) && Date.now() - c.lastSeen > 600000) clients.delete(id); }, 60000).unref();

function deliver(client, msg) {
  const w = pending.get(msg.id);
  if (!w) return;
  w.client = client.id; w.msg = msg; w.sentAt = 0;
  for (const t of w.ticketIds) { const tk = tickets.get(t); if (tk) tk.client = client.id; } // tickets follow the request
  if (client.waiter && !client.waiter.res.destroyed) {
    const wt = client.waiter; client.waiter = null;
    clearTimeout(wt.timer);
    w.sentAt = Date.now();
    send(wt.res, 200, msg);
  } else { client.waiter = null; client.queue.push(msg); }
}

// Re-route a request only if it was never acknowledged and its client is gone. Live
// extensions ack every request on their next poll, before running it.
setInterval(() => {
  for (const [, w] of pending) {
    if (!w.msg || w.acked || w.rerouted) continue;
    const c = clients.get(w.client);
    if (c && alive(c)) continue;
    if (w.sentAt && Date.now() - w.sentAt < 4000) continue;
    const next = pickClient(w.wanted);
    if (!next || next.id === w.client) continue;
    if (c) c.queue = c.queue.filter(m => m.id !== w.msg.id);
    w.rerouted = true;
    log('re-routing', w.msg.method, 'from', w.client, 'to', next.id);
    deliver(next, w.msg);
  }
}, 1000).unref();

// Attach a one-time exec ticket to every terminal.run (top level or inside batch).
function issueTickets(method, params, ids) {
  if (method === 'terminal.run' && params && typeof params.command === 'string') {
    const t = crypto.randomUUID();
    tickets.set(t, { command: params.command, cwd: params.cwd, shell: params.shell, timeout: params.timeout, client: null });
    ids.push(t);
    return { ...params, execTicket: t };
  }
  if (method === 'batch' && Array.isArray(params?.calls)) {
    return { ...params, calls: params.calls.map(c => ({ ...c, params: issueTickets(c.method, c.params || {}, ids) })) };
  }
  return params;
}

// shell: 'powershell' | 'pwsh' | 'bash' | 'cmd' | 'sh'; default VSCB_SHELL, else powershell on Windows, sh elsewhere.
function runLocal({ command, cwd, shell, timeout = 60000 }) {
  const sh = shell || process.env.VSCB_SHELL || (process.platform === 'win32' ? 'powershell' : 'sh');
  const argv = {
    powershell: ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]],
    pwsh: ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]],
    bash: ['bash', ['-lc', command]],
    cmd: ['cmd.exe', ['/d', '/s', '/c', command]],
    sh: ['/bin/sh', ['-c', command]],
  }[sh];
  if (!argv) return Promise.resolve({ exitCode: null, output: `unknown shell ${sh}`, timedOut: false });
  const dir = cwd || process.env.VSCB_CWD || os.homedir();
  log('exec', JSON.stringify(command).slice(0, 120), 'in', dir);
  return new Promise(resolve => {
    let output = '', timedOut = false, child;
    try { child = spawn(argv[0], argv[1], { cwd: dir, windowsHide: true, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } }); }
    catch (e) { return resolve({ exitCode: null, output: String(e.message || e), timedOut: false, cwd: dir }); }
    const add = d => { output += d.toString('utf8'); if (output.length > 2e6) output = output.slice(-1e6); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Number(timeout) || 60000);
    child.on('error', e => add(String(e.message || e)));
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut, cwd: dir }); });
  });
}

const server = http.createServer(async (req, res) => {
  if (!HOST_RE.test(req.headers.host || '')) return send(res, 421, { error: 'bad host' });
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const origin = req.headers.origin;
  if (process.env.VSCB_DEBUG === '1' && p !== '/ext-api/poll') log(req.method, p.replace(EXT_TOKEN, '<ext-token>'), origin || '-');

  try {
    // ---- extension files: secret capability path, EXT_TOKEN injected into extension.js ----
    if (p.startsWith('/ext/')) {
      if (!p.startsWith(EXT_PREFIX) && p !== EXT_PREFIX.slice(0, -1)) return send(res, 404, 'not found', 'text/plain');
      // vscode.dev fetches package.json from its own origin, so any origin may read this capability URL
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Private-Network', 'true'); }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const rel = decodeURIComponent(p.slice(EXT_PREFIX.length)) || 'package.json';
      const file = path.resolve(EXT_DIR, rel);
      if (!file.startsWith(EXT_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
      let data = fs.readFileSync(file);
      if (rel === 'extension.js') {
        data = data.toString('utf8').replace('__BRIDGE_URL__', `http://localhost:${PORT}`).replace('__BRIDGE_TOKEN__', EXT_TOKEN);
      }
      const type = rel.endsWith('.json') ? 'application/json' : rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.md') ? 'text/markdown' : 'application/octet-stream';
      return send(res, 200, data, type);
    }

    // ---- extension side ----
    if (p.startsWith('/ext-api/')) {
      if (!originAllowed(origin)) {
        if (!rejectedOrigins.has(origin)) log(`rejected /ext-api origin ${origin}; if this is your IDE: node vsc.mjs allow-origin ${origin}`);
        rejectedOrigins.set(origin, Date.now());
        return send(res, 403, { error: 'origin not allowed' });
      }
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (url.searchParams.get('token') !== EXT_TOKEN) return send(res, 401, { error: 'bad token' });
      const id = url.searchParams.get('client');
      if (!id || !/^[a-z0-9]{4,40}$/i.test(id)) return send(res, 400, { error: 'client required' });
      let c = clients.get(id);
      if (!c) {
        c = { id, name: '', info: {}, origin, lastSeen: Date.now(), connectedAt: Date.now(), focusedAt: 0, queue: [], waiter: null };
        clients.set(id, c);
        log('client connected', id, origin || '-');
      }
      c.lastSeen = Date.now();

      if (p === '/ext-api/hello' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 1e6) || '{}');
        c.name = String(body.name || c.name).slice(0, 200); c.info = body.info || c.info;
        if (body.focused) c.focusedAt = Date.now();
        log('hello', id, JSON.stringify(c.name));
        return send(res, 200, { ok: true });
      }
      if (p === '/ext-api/poll') {
        for (const a of (url.searchParams.get('ack') || '').split(',').filter(Boolean)) {
          const w = pending.get(a);
          if (w && w.client === id) w.acked = true;
        }
        // drop queued requests that were re-routed elsewhere or already timed out
        c.queue = c.queue.filter(m => pending.get(m.id)?.client === id);
        if (c.queue.length) {
          const m = c.queue.shift();
          pending.get(m.id).sentAt = Date.now();
          return send(res, 200, m);
        }
        if (c.waiter) { clearTimeout(c.waiter.timer); send(c.waiter.res, 204, ''); }
        const timer = setTimeout(() => { if (c.waiter?.res === res) { c.waiter = null; send(res, 204, ''); } }, 25000);
        c.waiter = { res, timer };
        req.on('close', () => { if (c.waiter?.res === res) { clearTimeout(timer); c.waiter = null; } });
        return;
      }
      if (p === '/ext-api/exec' && req.method === 'POST') {
        if (process.env.VSCB_NO_EXEC === '1') return send(res, 403, { error: 'local exec disabled (VSCB_NO_EXEC=1)' });
        const body = JSON.parse(await readBody(req, 1e6) || '{}');
        const t = tickets.get(body.execTicket);
        if (!t || t.client !== id) return send(res, 403, { error: 'exec needs a ticket from an agent terminal.run request' });
        tickets.delete(body.execTicket);
        return send(res, 200, await runLocal(t)); // runs the agent's command, not the caller's
      }
      if (p === '/ext-api/result' && req.method === 'POST') {
        const msg = JSON.parse(await readBody(req) || '{}');
        const w = pending.get(msg.id);
        if (w && w.client === id) { pending.delete(msg.id); clearTimeout(w.timer); w.resolve({ ...msg, client: id }); }
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'unknown ext-api route' });
    }

    // ---- agent side: never callable from browsers ----
    if (p === '/health') return send(res, 200, { ok: true, port: PORT });
    if (origin) return send(res, 403, { error: 'agent API is not callable from browsers' });
    if (req.headers['x-bridge-token'] !== TOKEN) return send(res, 401, { error: 'bad token' });

    if (p === '/install-url') return send(res, 200, { url: INSTALL_URL });
    if (p === '/ext-token') return send(res, 200, { token: EXT_TOKEN });
    if (p === '/origins') {
      if (req.method === 'POST') {
        const { add } = JSON.parse(await readBody(req, 1e5) || '{}');
        const o = String(add || '').trim().replace(/\/+$/, '').toLowerCase();
        if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(o)) return send(res, 400, { error: 'expected an origin like https://ide.example.com' });
        if (!extraOrigins().includes(o)) fs.appendFileSync(ORIGINS_FILE, o + '\n');
        rejectedOrigins.delete(o);
      }
      return send(res, 200, { builtin: BUILTIN_ORIGINS.map(String), extra: extraOrigins(), recentlyRejected: [...rejectedOrigins.keys()] });
    }
    if (p === '/shutdown' && req.method === 'POST') {
      send(res, 200, { ok: true });
      log('shutdown requested');
      return setTimeout(() => process.exit(0), 50);
    }
    if (p === '/clients') {
      return send(res, 200, [...clients.values()].map(c => ({
        id: c.id, name: c.name, origin: c.origin || null, alive: alive(c), lastSeenMsAgo: Date.now() - c.lastSeen, info: c.info,
      })));
    }
    if (p === '/rpc' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      // give a reloading / reconnecting window a moment to come back
      let client = pickClient(body.client);
      for (let waited = 0; !client && waited < Number(body.waitClient ?? 20000); waited += 250) {
        await new Promise(r => setTimeout(r, 250));
        client = pickClient(body.client);
      }
      if (!client) {
        const rej = [...rejectedOrigins.keys()].filter(Boolean);
        return send(res, 503, {
          ok: false, error: 'no VS Code web client connected. Keep the IDE tab open and make sure the Agent Bridge extension is installed (code-server: `vsc pack` + install VSIX; vscode.dev: `vsc install-url`).'
            + (rej.length ? ` Requests from these origins were rejected: ${rej.join(', ')}. If one is the user's IDE, confirm with the user, then run: vsc allow-origin <origin>` : ''),
        });
      }
      const id = crypto.randomUUID();
      const ticketIds = [];
      const params = issueTickets(body.method, body.params || {}, ticketIds);
      // the request must outlive the commands it carries (terminal.run defaults to a 60 s command timeout)
      const calls = body.method === 'batch' ? (body.params?.calls || []) : [{ method: body.method, params: body.params }];
      const cmdMs = calls.reduce((s, c) => s + (c?.method === 'terminal.run' ? Number(c.params?.timeout ?? 60000) + 15000 : 0), 0);
      const timeoutMs = Math.max(Number(body.timeout || 60000), cmdMs);
      const result = await new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ id, ok: false, error: `timeout after ${timeoutMs}ms` }); }, timeoutMs);
        pending.set(id, { resolve, timer, client: client.id, wanted: body.client, ticketIds, acked: false });
        deliver(client, { id, method: body.method, params });
      });
      for (const t of ticketIds) tickets.delete(t);
      return send(res, 200, { ...result, client: result.client || client.id });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', e?.stack || e);
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  log(`vscode-web-bridge listening on http://localhost:${PORT}`);
  log('install: code-server -> `node vsc.mjs pack`; vscode.dev -> `node vsc.mjs install-url`');
});
