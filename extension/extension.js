// Agent Bridge: web extension that long-polls a local bridge and executes
// agent requests against the VS Code API. Runs in the browser extension host.
const vscode = require('vscode');

const BRIDGE = '__BRIDGE_URL__';
const TOKEN = '__BRIDGE_TOKEN__';
const CLIENT = Math.random().toString(36).slice(2, 10);

let paused = false;
let status;
let out;
let stats = { handled: 0, errors: 0, lastMethod: '' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = `token=${encodeURIComponent(TOKEN)}&client=${CLIENT}`;
const enc = new TextEncoder();
const dec = new TextDecoder();
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[=>]|\r/g;

// ---------- helpers ----------
function root() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri : undefined;
}
function uri(p) {
  if (p === undefined || p === null || p === '') p = '.';
  if (p instanceof vscode.Uri) return p;
  // "folderName:rel/path" targets a specific workspace folder
  const m = /^([^:/\\]+):(.*)$/.exec(p);
  const folders = vscode.workspace.workspaceFolders || [];
  if (m && folders.some(f => f.name === m[1])) {
    return vscode.Uri.joinPath(folders.find(f => f.name === m[1]).uri, m[2] || '.');
  }
  // any scheme of 2+ chars (so Windows drive letters are not mistaken for one)
  if (/^[a-z][a-z0-9+.-]+:/i.test(p)) return vscode.Uri.parse(p);
  const r = root();
  if (!r) throw new Error('no workspace folder open; pass a full URI');
  if (p.startsWith('/')) return r.with({ path: p });
  return vscode.Uri.joinPath(r, p);
}
function rel(u) {
  const r = root();
  if (r && u.scheme === r.scheme && u.authority === r.authority && u.path.startsWith(r.path)) {
    return u.path.slice(r.path.length).replace(/^\//, '') || '.';
  }
  return u.toString();
}
const FT = { 0: 'unknown', 1: 'file', 2: 'dir', 64: 'symlink', 65: 'symlink-file', 66: 'symlink-dir' };
const pos = a => Array.isArray(a) ? new vscode.Position(a[0], a[1] || 0) : new vscode.Position(a.line, a.character || a.column || 0);
const rangeOf = (s, e) => new vscode.Range(pos(s), pos(e || s));
const fmtRange = r => ({ start: [r.start.line, r.start.character], end: [r.end.line, r.end.character] });

function ser(x, depth = 0, seen = new WeakSet()) {
  if (x === null || x === undefined) return x ?? null;
  if (typeof x !== 'object') return typeof x === 'function' ? '[function]' : x;
  if (x instanceof vscode.Uri) return x.toString();
  if (x instanceof vscode.Range) return fmtRange(x);
  if (x instanceof vscode.Position) return [x.line, x.character];
  if (x instanceof Uint8Array) return dec.decode(x);
  if (seen.has(x) || depth > 6) return '[…]';
  seen.add(x);
  if (Array.isArray(x)) return x.slice(0, 2000).map(v => ser(v, depth + 1, seen));
  const o = {};
  for (const k of Object.keys(x)) { try { o[k] = ser(x[k], depth + 1, seen); } catch { o[k] = '[unreadable]'; } }
  return o;
}

async function docFor(p) {
  if (p === undefined) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) throw new Error('no active editor; pass path');
    return ed.document;
  }
  return vscode.workspace.openTextDocument(uri(p));
}

function compileMatcher(pattern, opts = {}) {
  const src = opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(src, (opts.ignoreCase ? 'i' : '') + 'g');
}

// ---------- terminals ----------
function waitShellIntegration(t, ms) {
  if (t.shellIntegration) return Promise.resolve(t.shellIntegration);
  if (!vscode.window.onDidChangeTerminalShellIntegration) return Promise.resolve(undefined); // VS Code < 1.93
  return new Promise(resolve => {
    const timer = setTimeout(() => { d.dispose(); resolve(undefined); }, ms);
    const d = vscode.window.onDidChangeTerminalShellIntegration(e => {
      if (e.terminal === t) { clearTimeout(timer); d.dispose(); resolve(e.shellIntegration); }
    });
  });
}
function getTerminal({ name = 'agent', cwd, create = true, newTerminal = false } = {}) {
  let t = !newTerminal && vscode.window.terminals.find(x => x.name === name);
  if (!t && create) t = vscode.window.createTerminal({ name, cwd: cwd ? uri(cwd) : root() });
  if (!t) throw new Error(`no terminal named ${name}`);
  return t;
}
// Pure vscode.dev / github.dev has no terminal backend. In that case commands
// run on the local machine through the bridge (/ext-api/exec) and are echoed
// into a pseudoterminal so the user sees them in the VS Code UI.
let localTerm, localWrite = () => { };
function localTerminal(show) {
  if (!localTerm || localTerm.exitStatus) {
    const em = new vscode.EventEmitter();
    let ready, buf = '';
    localWrite = s => { s = s.replace(/\r?\n/g, '\r\n'); ready ? em.fire(s) : (buf += s); };
    localTerm = vscode.window.createTerminal({
      name: 'agent (local)',
      pty: { onDidWrite: em.event, open: () => { ready = true; em.fire('\x1b[90mAgent Bridge: commands here run on the local machine.\x1b[0m\r\n' + buf); buf = ''; }, close: () => { localTerm = undefined; } },
    });
  }
  if (show) localTerm.show(true);
}
async function localRun(p) {
  localTerminal(p.show !== false);
  localWrite(`\x1b[36m${p.cwd ? p.cwd + ' ' : ''}$ ${p.command}\x1b[0m\n`);
  if (!p.execTicket) throw new Error('local terminal.run must be a direct agent call (no exec ticket)');
  const r = await post('exec', { execTicket: p.execTicket });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `exec failed (${r.status})`);
  localWrite(j.output + (j.output && !j.output.endsWith('\n') ? '\n' : '') + `\x1b[90m[exit ${j.exitCode}${j.timedOut ? ', timed out' : ''}]\x1b[0m\n`);
  let text = j.output;
  const max = p.maxChars ?? 50000;
  if (text.length > max) text = '…[truncated]…\n' + text.slice(-max);
  return { terminal: 'agent (local)', local: true, captured: true, exitCode: j.exitCode, timedOut: j.timedOut, cwd: j.cwd, output: text };
}
// No terminal backend: plain vscode.dev / github.dev without a remote.
const noBackend = () => !vscode.env.remoteName && /(^|\.)(vscode|github)\.dev$/.test(vscode.env.appHost || '');
async function terminalRun(p) {
  if (typeof p.command !== 'string' || !p.command) throw new Error('terminal.run needs a command string');
  if (p.local === true || (p.local === undefined && noBackend())) return localRun(p);
  if (!vscode.workspace.isTrusted) throw new Error('workspace is in Restricted Mode, so terminals are blocked; ask the user to trust the folder (cmd.run workbench.trust.manage)');
  let t;
  try { t = getTerminal(p); }
  catch (e) { if (p.local === undefined) return localRun(p); throw e; }
  if (p.show !== false) t.show(true);
  const si = await waitShellIntegration(t, p.integrationWaitMs ?? 10000);
  if (!si) {
    t.sendText(p.command, true);
    return { terminal: t.name, captured: false, note: 'shell integration unavailable (or no terminal backend); text sent, output not captured' };
  }
  // rc files (e.g. a `cd` in .bashrc) can override the start dir: cd explicitly on first use or when asked
  const want = p.cwd ? uri(p.cwd) : !cwdChecked.has(t) ? root() : undefined;
  cwdChecked.add(t);
  // 'path' quoting works in sh/bash/zsh/fish/pwsh; skip cmd.exe and paths containing a quote
  const cmdExe = /cmd(\.exe)?$/i.test(vscode.env.shell || '');
  if (want && !cmdExe && !want.path.includes("'") && (!si.cwd || si.cwd.path !== want.path)) await shellExec(si, `cd '${want.path}'`, 10000);
  const r = await shellExec(si, p.command, p.timeout ?? 60000);
  let text = r.output.replace(ANSI, '');
  const max = p.maxChars ?? 50000;
  if (text.length > max) text = '…[truncated]…\n' + text.slice(-max);
  return { terminal: t.name, captured: true, exitCode: r.exitCode, timedOut: r.timedOut, cwd: si.cwd ? si.cwd.toString() : null, output: text };
}
const cwdChecked = new WeakSet();
async function shellExec(si, command, timeout) {
  const exec = si.executeCommand(command);
  let output = '';
  const reading = (async () => { try { for await (const d of exec.read()) output += d; } catch { } })();
  const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => { d.dispose(); resolve('timeout'); }, timeout);
    const d = vscode.window.onDidEndTerminalShellExecution(e => {
      if (e.execution === exec) { clearTimeout(timer); d.dispose(); resolve(e.exitCode); }
    });
  });
  await Promise.race([reading, sleep(300)]);
  return { output, exitCode: exitCode === 'timeout' ? null : exitCode ?? null, timedOut: exitCode === 'timeout' };
}

// ---------- methods ----------
const M = {
  ping: () => ({ pong: true, client: CLIENT, t: Date.now() }),

  info: () => {
    const ed = vscode.window.activeTextEditor;
    return {
      client: CLIENT,
      appName: vscode.env.appName, appHost: vscode.env.appHost, uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
      remoteName: vscode.env.remoteName || null, version: vscode.version, trusted: vscode.workspace.isTrusted,
      workspaceFolders: (vscode.workspace.workspaceFolders || []).map(f => ({ name: f.name, uri: f.uri.toString() })),
      activeEditor: ed ? { path: rel(ed.document.uri), uri: ed.document.uri.toString(), languageId: ed.document.languageId, dirty: ed.document.isDirty, selection: fmtRange(ed.selection), lines: ed.document.lineCount } : null,
      openTabs: vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => ({ label: t.label, active: t.isActive, dirty: t.isDirty, uri: t.input && t.input.uri ? t.input.uri.toString() : null }))),
      terminals: vscode.window.terminals.map(t => ({ name: t.name, shellIntegration: !!t.shellIntegration })),
    };
  },

  // ---- files ----
  'fs.read': async ({ path, fromEditor = true, startLine, endLine }) => {
    const u = uri(path);
    let text;
    const open = fromEditor && vscode.workspace.textDocuments.find(d => d.uri.toString() === u.toString());
    text = open ? open.getText() : dec.decode(await vscode.workspace.fs.readFile(u));
    if (startLine !== undefined || endLine !== undefined) {
      const lines = text.split('\n');
      text = lines.slice(startLine ?? 0, endLine ?? lines.length).join('\n');
    }
    return text;
  },
  'fs.write': async ({ path, content = '', open = false, append = false }) => {
    const u = uri(path);
    const parent = vscode.Uri.joinPath(u, '..');
    try { await vscode.workspace.fs.createDirectory(parent); } catch { }
    let data = content;
    if (append) { try { data = dec.decode(await vscode.workspace.fs.readFile(u)) + content; } catch { } }
    await vscode.workspace.fs.writeFile(u, enc.encode(data));
    if (open) await vscode.window.showTextDocument(u, { preview: false });
    return { path: rel(u), bytes: enc.encode(data).length };
  },
  'fs.list': async ({ path, depth = 1, max = 2000 }) => {
    const res = [];
    const walk = async (u, d, prefix) => {
      if (res.length >= max) return;
      const entries = await vscode.workspace.fs.readDirectory(u);
      entries.sort((a, b) => (b[1] & 2) - (a[1] & 2) || a[0].localeCompare(b[0]));
      for (const [name, type] of entries) {
        if (res.length >= max) return;
        const r = prefix ? `${prefix}/${name}` : name;
        res.push(FT[type] === 'dir' || type & 2 ? r + '/' : r);
        if (type & 2 && d > 1 && !/^(\.git|node_modules)$/.test(name)) await walk(vscode.Uri.joinPath(u, name), d - 1, r);
      }
    };
    await walk(uri(path), depth, '');
    return res;
  },
  'fs.stat': async ({ path }) => {
    const s = await vscode.workspace.fs.stat(uri(path));
    return { type: FT[s.type] || s.type, size: s.size, mtime: s.mtime, ctime: s.ctime };
  },
  'fs.exists': async ({ path }) => { try { await vscode.workspace.fs.stat(uri(path)); return true; } catch { return false; } },
  'fs.mkdir': async ({ path }) => { await vscode.workspace.fs.createDirectory(uri(path)); return { ok: true }; },
  'fs.delete': async ({ path, recursive = true, useTrash = false }) => { await vscode.workspace.fs.delete(uri(path), { recursive, useTrash }); return { ok: true }; },
  'fs.rename': async ({ from, to, overwrite = false }) => { await vscode.workspace.fs.rename(uri(from), uri(to), { overwrite }); return { ok: true }; },
  'fs.copy': async ({ from, to, overwrite = false }) => { await vscode.workspace.fs.copy(uri(from), uri(to), { overwrite }); return { ok: true }; },
  'fs.find': async ({ include = '**/*', exclude = '**/{node_modules,.git}/**', max = 500 }) =>
    (await vscode.workspace.findFiles(include, exclude, max)).map(rel),
  'fs.grep': async ({ pattern, include = '**/*', exclude = '**/{node_modules,.git,dist,build,out}/**', regex = false, ignoreCase = false, maxFiles = 2000, maxMatches = 300, maxFileBytes = 1000000 }) => {
    const re = compileMatcher(pattern, { regex, ignoreCase });
    const files = await vscode.workspace.findFiles(include, exclude, maxFiles);
    const hits = [];
    await Promise.all(files.map(async f => {
      if (hits.length >= maxMatches) return;
      let bytes;
      try { bytes = await vscode.workspace.fs.readFile(f); } catch { return; }
      if (bytes.length > maxFileBytes || bytes.subarray(0, 4096).includes(0)) return;
      const lines = dec.decode(bytes).split('\n');
      for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) hits.push(`${rel(f)}:${i + 1}: ${lines[i].slice(0, 300)}`);
      }
    }));
    return hits.sort();
  },

  // ---- editors ----
  'editor.open': async ({ path, line, column = 0, preview = false, preserveFocus = false }) => {
    const ed = await vscode.window.showTextDocument(uri(path), { preview, preserveFocus });
    if (line !== undefined) {
      const p = new vscode.Position(Math.max(0, line - 1), column);
      ed.selection = new vscode.Selection(p, p);
      ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter);
    }
    return { path: rel(ed.document.uri), languageId: ed.document.languageId };
  },
  'editor.text': async ({ path } = {}) => (await docFor(path)).getText(),
  'editor.selection': () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return null;
    return { path: rel(ed.document.uri), selections: ed.selections.map(s => ({ ...fmtRange(s), text: ed.document.getText(s) })) };
  },
  'editor.select': async ({ path, start, end, line, endLine }) => {
    const ed = path ? await vscode.window.showTextDocument(uri(path), { preview: false }) : vscode.window.activeTextEditor;
    if (!ed) throw new Error('no editor');
    const r = line !== undefined ? new vscode.Range(line - 1, 0, (endLine ?? line) - 1, 1e6) : rangeOf(start, end);
    ed.selection = new vscode.Selection(r.start, r.end);
    ed.revealRange(r, vscode.TextEditorRevealType.InCenter);
    return { selected: ed.document.getText(ed.selection) };
  },
  // edits: [{start:[line,col], end:[line,col], text}] (0-based) or {line, endLine, text} (1-based, whole lines)
  'editor.edit': async ({ path, edits = [], save = false }) => {
    const doc = await docFor(path);
    const we = new vscode.WorkspaceEdit();
    for (const e of edits) {
      const r = e.line !== undefined
        ? new vscode.Range(e.line - 1, 0, (e.endLine ?? e.line), 0)
        : rangeOf(e.start, e.end);
      we.replace(doc.uri, doc.validateRange(r), e.text ?? '');
    }
    const ok = await vscode.workspace.applyEdit(we);
    if (save) await doc.save();
    return { ok, path: rel(doc.uri), dirty: doc.isDirty };
  },
  'editor.replace': async ({ path, find, replace = '', regex = false, all = true, ignoreCase = false, save = false }) => {
    const doc = await docFor(path);
    const text = doc.getText();
    const re = compileMatcher(find, { regex, ignoreCase });
    const we = new vscode.WorkspaceEdit();
    let n = 0, m;
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      const rep = regex ? m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), replace) : replace;
      we.replace(doc.uri, new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)), rep);
      n++;
      if (!all) break;
    }
    if (n) await vscode.workspace.applyEdit(we);
    if (save && n) await doc.save();
    return { replaced: n, path: rel(doc.uri) };
  },
  'editor.insert': async ({ path, text, at }) => {
    const ed = path ? await vscode.window.showTextDocument(uri(path), { preview: false }) : vscode.window.activeTextEditor;
    if (!ed) throw new Error('no editor');
    const ok = await ed.edit(b => at ? b.insert(pos(at), text) : ed.selections.forEach(s => b.replace(s, text)));
    return { ok };
  },
  'editor.save': async ({ path, all = false } = {}) => {
    if (all) return { ok: await vscode.workspace.saveAll(false) };
    return { ok: await (await docFor(path)).save() };
  },
  'editor.close': async ({ path, all = false } = {}) => {
    if (all) return { ok: await vscode.commands.executeCommand('workbench.action.closeAllEditors').then(() => true) };
    const u = path ? uri(path).toString() : null;
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => u ? t.input && t.input.uri && t.input.uri.toString() === u : t.isActive);
    return { ok: await vscode.window.tabGroups.close(tabs) };
  },

  // ---- language features ----
  diagnostics: ({ path, severity } = {}) => {
    const sev = ['error', 'warning', 'info', 'hint'];
    const list = path ? [[uri(path), vscode.languages.getDiagnostics(uri(path))]] : vscode.languages.getDiagnostics();
    const res = [];
    for (const [u, ds] of list) for (const d of ds) {
      if (severity && sev[d.severity] !== severity) continue;
      res.push(`${rel(u)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev[d.severity]} ${d.message}${d.source ? ` [${d.source}]` : ''}`);
    }
    return res;
  },
  symbols: async ({ path } = {}) => {
    const doc = await docFor(path);
    const syms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri) || [];
    const flat = (s, d = 0) => [`${'  '.repeat(d)}${vscode.SymbolKind[s.kind]} ${s.name} :${(s.range || s.location.range).start.line + 1}`, ...(s.children || []).flatMap(c => flat(c, d + 1))];
    return syms.flatMap(s => flat(s));
  },
  format: async ({ path, save = false } = {}) => {
    const doc = await docFor(path);
    const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 2, insertSpaces: true }) || [];
    const we = new vscode.WorkspaceEdit(); we.set(doc.uri, edits);
    await vscode.workspace.applyEdit(we);
    if (save) await doc.save();
    return { edits: edits.length };
  },

  // ---- commands (covers most "clicks": every menu/button is a command) ----
  // args may contain {"$uri": "path or URI"} or "uri:path" to pass a vscode.Uri
  'cmd.run': async ({ command, args = [] }) => {
    const conv = a => a && typeof a === 'object' && !Array.isArray(a) && typeof a.$uri === 'string' ? uri(a.$uri)
      : typeof a === 'string' && a.startsWith('uri:') ? uri(a.slice(4)) : a;
    return ser(await vscode.commands.executeCommand(command, ...(Array.isArray(args) ? args : [args]).map(conv)));
  },
  'cmd.list': async ({ filter = '' } = {}) => (await vscode.commands.getCommands(true)).filter(c => c.toLowerCase().includes(filter.toLowerCase())).sort(),

  // ---- terminals ----
  'terminal.run': terminalRun,
  'terminal.send': ({ name = 'agent', text, enter = true, show = true }) => {
    const t = getTerminal({ name });
    if (show) t.show(true);
    t.sendText(text, enter);
    return { ok: true, terminal: t.name };
  },
  'terminal.list': () => vscode.window.terminals.map(t => ({ name: t.name, shellIntegration: !!t.shellIntegration, cwd: t.shellIntegration && t.shellIntegration.cwd ? t.shellIntegration.cwd.toString() : null, exitStatus: t.exitStatus ? t.exitStatus.code : null })),
  'terminal.kill': ({ name = 'agent' }) => { getTerminal({ name, create: false }).dispose(); return { ok: true }; },

  // ---- UI ----
  notify: ({ message, level = 'info' }) => {
    const f = { info: 'showInformationMessage', warn: 'showWarningMessage', error: 'showErrorMessage' }[level] || 'showInformationMessage';
    vscode.window[f](String(message));
    return { ok: true };
  },
  'clipboard.read': () => vscode.env.clipboard.readText(),
  'clipboard.write': async ({ text }) => { await vscode.env.clipboard.writeText(text); return { ok: true }; },

  // ---- escape hatch: run JS in the extension host with `vscode`, `params`, `uri`, `rel` in scope ----
  eval: async ({ code, ...params }) => {
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    const fn = new AsyncFunction('vscode', 'params', 'uri', 'rel', code.includes('return') ? code : `return (${code});`);
    return ser(await fn(vscode, params, uri, rel));
  },

  // ---- many calls in one round trip ----
  batch: async ({ calls = [], stopOnError = false }) => {
    const res = [];
    for (const c of calls) {
      try { res.push({ ok: true, result: await dispatch(c.method, c.params || {}) }); }
      catch (e) { res.push({ ok: false, error: String(e && e.message || e) }); if (stopOnError) break; }
    }
    return res;
  },
};

async function dispatch(method, params) {
  const f = M[method];
  if (!f) throw new Error(`unknown method ${method}. Known: ${Object.keys(M).join(', ')}`);
  return f(params || {});
}

// ---------- transport ----------
async function post(route, body) {
  // text/plain keeps this a CORS "simple request" (no preflight)
  return fetch(`${BRIDGE}/ext-api/${route}?${q}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
}
function helloBody() {
  const f = vscode.workspace.workspaceFolders;
  return {
    name: vscode.workspace.name || (f && f[0] && f[0].name) || '(no folder)',
    focused: vscode.window.state.focused,
    info: { appHost: vscode.env.appHost, remoteName: vscode.env.remoteName || null, folders: (f || []).map(x => x.uri.toString()) },
  };
}
function hello() { return post('hello', helloBody()).catch(() => { }); }
async function handle(msg) {
  stats.lastMethod = msg.method;
  out.appendLine(`→ ${msg.method} ${JSON.stringify(msg.params).slice(0, 200)}`);
  let reply;
  if (paused) reply = { id: msg.id, ok: false, error: 'Agent Bridge is paused in this window' };
  else {
    try { reply = { id: msg.id, ok: true, result: await dispatch(msg.method, msg.params) }; stats.handled++; }
    catch (e) { reply = { id: msg.id, ok: false, error: String(e && e.message || e) }; stats.errors++; out.appendLine(`  ✗ ${reply.error}`); }
  }
  try { await post('result', reply); } catch (e) { out.appendLine(`  result post failed: ${e}`); }
  setStatus(true);
}
function setStatus(connected) {
  status.text = paused ? '$(debug-pause) Agent' : connected ? '$(plug) Agent' : '$(debug-disconnect) Agent';
  status.tooltip = `Agent Bridge ${paused ? 'paused' : connected ? 'connected' : 'disconnected'} (${BRIDGE})\nclient ${CLIENT} · handled ${stats.handled} · errors ${stats.errors}${stats.lastMethod ? ` · last ${stats.lastMethod}` : ''}`;
}
// One poll loop at a time: a new generation (reconnect) aborts the previous loop's poll.
let generation = 0, pollAbort;
const acks = [];
async function loop() {
  const gen = ++generation;
  if (pollAbort) pollAbort.abort();
  let backoff = 1000, said = false;
  while (gen === generation) {
    if (paused) { await sleep(1000); continue; }
    try {
      if (!said) {
        const h = await post('hello', helloBody());
        if (!h.ok) throw new Error(`hello ${h.status}`);
        said = true; out.appendLine(`connected to ${BRIDGE} as ${CLIENT}`);
      }
      pollAbort = new AbortController();
      // ack ids received so far: tells the bridge they arrived and must not be re-routed
      const ack = acks.splice(0).join(',');
      const r = await fetch(`${BRIDGE}/ext-api/poll?${q}${ack ? `&ack=${ack}` : ''}`, { cache: 'no-store', signal: pollAbort.signal });
      if (gen !== generation) break;
      setStatus(true); backoff = 1000;
      if (r.status === 200) {
        const msg = await r.json();
        acks.push(msg.id);
        setTimeout(() => handle(msg), 0); // re-poll (and ack) before running the request
      } else if (r.status === 401 || r.status === 403) {
        out.appendLine(`bridge rejected this window (${r.status}); rebuild/reinstall the extension or allow this origin (vsc allow-origin)`);
        await sleep(10000);
      }
    } catch (e) {
      if (gen !== generation) break;
      if (said) out.appendLine(`bridge unreachable: ${e}`);
      said = false; setStatus(false);
      await sleep(backoff); backoff = Math.min(backoff * 2, 15000);
    }
  }
}

function activate(context) {
  out = vscode.window.createOutputChannel('Agent Bridge');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'agentBridge.status';
  setStatus(false); status.show();
  context.subscriptions.push(out, status,
    vscode.commands.registerCommand('agentBridge.status', () => { out.show(true); setStatus(true); vscode.window.showInformationMessage(status.tooltip.replace(/\n/g, ' · ')); }),
    vscode.commands.registerCommand('agentBridge.reconnect', () => loop()),
    vscode.commands.registerCommand('agentBridge.toggle', () => { paused = !paused; setStatus(!paused); }),
    vscode.window.onDidChangeWindowState(s => { if (s.focused) hello(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => hello()),
    { dispose: () => { generation++; if (pollAbort) pollAbort.abort(); } },
  );
  loop();
}
function deactivate() { generation++; if (pollAbort) pollAbort.abort(); }
module.exports = { activate, deactivate };
