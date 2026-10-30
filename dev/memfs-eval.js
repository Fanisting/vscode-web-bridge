const files = new Map([['/', null]]); const E = new vscode.EventEmitter();
const FT = vscode.FileType;
const st = p => { if (!files.has(p)) throw vscode.FileSystemError.FileNotFound(p); const v = files.get(p); return { type: v === null ? FT.Directory : FT.File, ctime: 0, mtime: Date.now(), size: v ? v.length : 0 }; };
globalThis.__memfs ??= vscode.workspace.registerFileSystemProvider('agentmem', {
  onDidChangeFile: E.event, watch: () => ({ dispose() {} }),
  stat: u => st(u.path),
  readDirectory: u => [...files.keys()].filter(k => k !== u.path && k.startsWith(u.path === '/' ? '/' : u.path + '/') && !k.slice((u.path === '/' ? 0 : u.path.length) + 1).includes('/')).map(k => [k.split('/').pop(), files.get(k) === null ? FT.Directory : FT.File]),
  createDirectory: u => { files.set(u.path, null); },
  readFile: u => { st(u.path); return files.get(u.path); },
  writeFile: (u, c) => { files.set(u.path, c); E.fire([{ type: 1, uri: u }]); },
  delete: u => { for (const k of [...files.keys()]) if (k === u.path || k.startsWith(u.path + '/')) files.delete(k); },
  rename: (a, b) => { files.set(b.path, files.get(a.path)); files.delete(a.path); },
}, { isCaseSensitive: true });
return 'memfs registered';
