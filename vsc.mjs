#!/usr/bin/env node
// CLI for vscode-web-bridge.
//   node vsc.mjs <method> [json | key=value ...] [--client <id|name>] [--timeout ms] [--json]
//   node vsc.mjs clients | start | stop | help
// key=value values are JSON-parsed when possible; key=@file reads a local file; key=@- reads stdin.
// A bare argument without "=" is the method's main parameter (path, pattern, command, ...).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.VSCB_PORT || 47821);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = path.join(os.homedir(), '.vscode-web-bridge');
const BRIDGE_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.mjs');

const HELP = `vsc <method> [json | key=value ...] [--client id|name] [--timeout ms] [--json]
  bridge:   start | stop | clients | install-url | pack [out=file.vsix] | origins | allow-origin https://ide.example.com | help
  info:     ping | info
  files:    fs.read path [startLine endLine] | fs.write path content=@local.txt [open append]
            fs.list [path] [depth] | fs.stat | fs.exists | fs.mkdir | fs.delete | fs.rename from to
            fs.copy from to | fs.find include=glob | fs.grep pattern [include regex ignoreCase]
  editor:   editor.open path [line] | editor.text [path] | editor.selection | editor.select line|start,end
            editor.edit edits=[{line,endLine,text}|{start,end,text}] [save] | editor.replace find replace [regex all save]
            editor.insert text [at] | editor.save [path|all] | editor.close [path|all]
  language: diagnostics [path severity] | symbols [path] | format [path save]
  ui:       cmd.run command [args] | cmd.list [filter] | notify message [level] | clipboard.read | clipboard.write text
  terminal: terminal.run command [name cwd timeout shell local] | terminal.send text [name] | terminal.list | terminal.kill name
  misc:     eval code (JS in extension host; vscode, params, uri, rel in scope) | batch calls=[{method,params}]
Paths: relative to the first workspace folder, "Folder:rel/path", or a full URI (vscode-remote://..., agentmem:/...).`;

const argv = process.argv.slice(2);
const opt = { client: undefined, timeout: undefined, json: false };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--client') opt.client = argv[++i];
  else if (argv[i] === '--timeout') opt.timeout = Number(argv[++i]);
  else if (argv[i] === '--json') opt.json = true;
  else rest.push(argv[i]);
}
const [method, ...args] = rest;
if (!method || method === 'help' || method === '--help') { console.log(HELP); process.exit(method ? 0 : 2); }

function readVal(v) {
  if (v === '@-') return fs.readFileSync(0, 'utf8');
  if (v.startsWith('@') && fs.existsSync(v.slice(1))) return fs.readFileSync(v.slice(1), 'utf8');
  try { return JSON.parse(v); } catch { return v; }
}
// Ordered meaning of bare (key-less) arguments per method; default is [path].
const POSITIONAL = {
  'fs.read': ['path', 'startLine', 'endLine'], 'fs.write': ['path', 'content'], 'fs.rename': ['from', 'to'], 'fs.copy': ['from', 'to'],
  'fs.grep': ['pattern', 'include'], 'fs.find': ['include'], 'editor.open': ['path', 'line'], 'editor.select': ['line', 'endLine'],
  'editor.replace': ['find', 'replace'], 'editor.insert': ['text'], 'terminal.run': ['command'], 'terminal.send': ['text'],
  'terminal.kill': ['name'], 'cmd.run': ['command'], 'cmd.list': ['filter'], notify: ['message'], eval: ['code'],
  'clipboard.write': ['text'], diagnostics: ['path'], symbols: ['path'], format: ['path'], 'allow-origin': ['origin'],
};
const NUMERIC = new Set(['startLine', 'endLine', 'line', 'depth', 'timeout', 'max']);
// `k=v` is a parameter only if k is a known parameter name; otherwise the whole arg is positional
// (so commands like `x=7; echo $x` or patterns like `a=b` stay intact).
const KNOWN = new Set(('path content open append depth max recursive useTrash from to overwrite include exclude pattern regex ignoreCase ' +
  'maxFiles maxMatches maxFileBytes line column preview preserveFocus start end endLine startLine fromEditor edits save find replace all text at ' +
  'severity command args name cwd timeout shell local show newTerminal maxChars integrationWaitMs enter message level code calls stopOnError ' +
  'filter out url origin').split(' '));

let params = {};
let jsonArg = null;
if (args.length === 1 && /^\s*[{]/.test(args[0])) { try { jsonArg = JSON.parse(args[0]); } catch { } }
if (jsonArg) params = jsonArg;
else {
  const pos = [];
  for (const a of args) {
    const k = a.indexOf('=');
    if (k > 0 && KNOWN.has(a.slice(0, k))) params[a.slice(0, k)] = readVal(a.slice(k + 1));
    else pos.push(a);
  }
  const names = POSITIONAL[method] || ['path'];
  pos.forEach((v, i) => {
    const n = names[Math.min(i, names.length - 1)];
    if (i >= names.length && method === 'cmd.run') { (params.args ??= []).push(readVal(v)); return; }
    if (i >= names.length) { console.error(`vsc: unexpected extra argument ${JSON.stringify(v)}`); process.exit(2); }
    params[n] ??= NUMERIC.has(n) && /^-?\d+$/.test(v) ? Number(v) : v;
  });
}

const up = () => fetch(`${BASE}/health`).then(r => r.ok, () => false);
async function ensureBridge() {
  if (await up()) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(STATE_DIR, 'bridge.log'), 'a');
  spawn(process.execPath, [BRIDGE_JS], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true }).unref();
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise(r => setTimeout(r, 100));
  if (!(await up())) throw new Error(`could not start ${BRIDGE_JS}; see ${path.join(STATE_DIR, 'bridge.log')}`);
  console.error('[vsc] started bridge; the VS Code tab reconnects within ~15s');
}

async function main() {
try {
  if (method === 'stop') {
    if (!(await up())) { console.log('bridge not running'); return void (process.exitCode = 0); }
  } else await ensureBridge();
  const TOKEN = fs.readFileSync(path.join(STATE_DIR, 'token'), 'utf8').trim();
  const headers = { 'x-bridge-token': TOKEN, 'content-type': 'application/json' };

  if (method === 'start') { console.log(`bridge up at ${BASE}`); return void (process.exitCode = 0); }
  if (method === 'stop') { await fetch(`${BASE}/shutdown`, { method: 'POST', headers }).catch(() => { }); console.log('bridge stopped'); return void (process.exitCode = 0); }
  if (method === 'pack') {
    const { pack, defaultVsixPath } = await import('./pack.mjs');
    const extToken = (await (await fetch(`${BASE}/ext-token`, { headers })).json()).token;
    const out = pack({ out: path.resolve(params.out || params.path || defaultVsixPath()), url: params.url || `http://localhost:${PORT}`, token: extToken });
    console.log(out); return;
  }
  if (method === 'allow-origin' || method === 'origins') {
    const r = await fetch(`${BASE}/origins`, method === 'origins' ? { headers } : { method: 'POST', headers, body: JSON.stringify({ add: params.origin }) });
    const j = await r.json();
    if (!r.ok) { console.error(`error: ${j.error}`); return void (process.exitCode = 1); }
    console.log(JSON.stringify(j, null, 2)); return;
  }
  if (method === 'install-url') { console.log((await (await fetch(`${BASE}/install-url`, { headers })).json()).url); return; }
  if (method === 'clients') { console.log(JSON.stringify(await (await fetch(`${BASE}/clients`, { headers })).json(), null, 2)); return void (process.exitCode = 0); }

  const r = await fetch(`${BASE}/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, params, client: opt.client, timeout: opt.timeout }) });
  const res = await r.json();
  if (!res.ok) { console.error(`error: ${res.error}`); return void (process.exitCode = 1); }
  const v = res.result;
  if (opt.json) console.log(JSON.stringify(v, null, 2));
  else if (typeof v === 'string') process.stdout.write(v.endsWith('\n') ? v : v + '\n');
  else if (Array.isArray(v) && v.every(x => typeof x === 'string')) console.log(v.join('\n'));
  else if (method === 'terminal.run' && v && typeof v.output === 'string') {
    process.stdout.write(v.output.endsWith('\n') || !v.output ? v.output : v.output + '\n');
    console.error(`[exit ${v.exitCode}${v.timedOut ? ', timed out' : ''}]`);
    return void (process.exitCode = typeof v.exitCode === 'number' ? v.exitCode : v.timedOut ? 124 : 0);
  } else console.log(JSON.stringify(v, null, 2));
} catch (e) {
  console.error(`vsc: ${e.message}`);
  return void (process.exitCode = 1);
}
}
await main();
