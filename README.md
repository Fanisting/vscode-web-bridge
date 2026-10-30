# vscode-web-bridge

**Let a local coding agent drive the VS Code that is open in your browser.**

Supported targets are code-server in a remote container, vscode.dev and github.dev. The agent can:
- read and edit files;
- run terminal commands and get the real output and exit code;
- trigger any VS Code command.

Everything goes through the VS Code extension API. You don't need screenshots, pixel clicking, or SSH into the container.

```
$ vsc fs.grep "def train" include="**/*.py"
src/train.py:42: def train(cfg):
$ vsc editor.replace path=src/train.py find="lr=1e-3" replace="lr=3e-4" save=true
{ "replaced": 1, "path": "src/train.py" }
$ vsc terminal.run 'python3 -m pytest -q'
12 passed in 3.41s
[exit 0]
```

It has zero dependencies and needs only Node 18+ and Chrome (or another Chromium browser). A call takes about 300 ms.

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Features](#features)
- [Quick start](#quick-start)
- [Using it from an AI agent](#using-it-from-an-ai-agent)
- [CLI](#cli)
- [Method reference](#method-reference)
- [HTTP API](#http-api)
- [Security model](#security-model)
- [Configuration](#configuration)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Why

Many dev environments live in a browser tab. Examples include a code-server instance inside a company container, a cloud workstation, or vscode.dev. A coding agent on your laptop usually can't reach them, for one of three reasons:
- the container accepts no inbound SSH;
- it sits behind a gateway;
- it only exposes the web IDE.

Browser automation (screenshots plus clicks) works, but it is slow and flaky. It also can't see file contents or command output. This project relies on two facts instead:

- **The browser can reach both sides.** Chrome talks to the remote IDE and to your laptop's `localhost`.
- **VS Code web runs extensions inside the browser.** A web extension there has the full workspace API:
  the remote file system, terminals, editors, diagnostics and commands.

A small web extension inside the IDE tab polls a relay on your laptop for work. Your agent calls the relay. The extension runs the call through the real VS Code API, and the result comes back in one round trip.

## How it works

```
┌────────────── your machine ──────────────┐        ┌──────────── Chrome tab ────────────┐
│                                          │        │  VS Code web (code-server, ...)    │
│  agent ──HTTP──▶ bridge.mjs              │◀─poll──│  Agent Bridge web extension        │
│  (vsc.mjs CLI)   127.0.0.1:47821         │──rpc──▶│  (runs in the browser's extension  │
│                                          │        │   host worker)                     │
└──────────────────────────────────────────┘        └───────────────┬────────────────────┘
                                                                     │ VS Code API
                                                                     ▼
                                                    remote files · terminals · editors · commands
                                                    (inside the container the IDE is attached to)
```

| File | Role |
|---|---|
| `bridge.mjs` | Relay on `127.0.0.1:47821`. It queues calls per window, hands them to the polling extensions and tracks acknowledgements. It also serves the extension files at a secret path and enforces tokens and origins. |
| `extension/extension.js` | The web extension (`extensionKind: web`, no build step). Implements every method against the VS Code API. |
| `vsc.mjs` | CLI. Starts the bridge on demand, parses arguments, prints results, passes through exit codes. |
| `pack.mjs` | Builds the VSIX with no dependencies. Bakes the bridge URL and extension token into the package. |
| `SKILL.md` | Usage guide written for agents (Claude Code / Agent Skills format). |
| `START.md` | Step-by-step setup script you can hand to any agent. |

A call flows like this:

1. The agent sends `POST /rpc {method, params}` with the master token.
2. The bridge picks the target window (the most recently focused one, or `--client`) and passes the message to that window's waiting poll.
3. The extension acknowledges the message on its next poll, runs the method, and posts the result back.
4. The bridge answers the agent's request.

If a window reloads before acknowledging a message, the bridge re-routes the message to a live window. An acknowledged message is never re-sent, so commands run at most once.

## Features

- **Files** in the remote workspace: read (with line ranges), write, append, list trees, stat, mkdir, delete,
  rename, copy, glob find, and grep (literal or regex).
- **Editors**: open at a line, read unsaved text, select, line or range edits, find and replace, insert, save,
  close, format.
- **Terminals**: `terminal.run` runs in the IDE's real remote shell and returns `{output, exitCode, timedOut}`, using VS Code's shell integration. Named terminals persist between calls. On first use it `cd`s into the workspace root, because `.bashrc` files often `cd` elsewhere.
- **Commands**: every menu item and button is a command, so `cmd.list` plus `cmd.run` covers most "clicks".
  Arguments can carry `vscode.Uri` values.
- **Language features**: diagnostics (problems), document symbols.
- **UI**: notifications, clipboard.
- **Escape hatch**: `eval` runs JavaScript in the extension host with `vscode` in scope.
- **Batching**: many calls in one round trip.
- **Multiple windows**: list connected tabs and target one by id or name.
- **No-backend fallback**: plain vscode.dev and github.dev have no remote machine. There, `terminal.run` runs on your local machine instead and mirrors the output into an `agent (local)` terminal.

## Quick start

Requirements:
- **Node 18+** on the machine that runs Chrome.
- A browser VS Code that supports web extensions: code-server 4.x, vscode.dev or github.dev.
- VS Code **1.93+** inside the IDE, for captured terminal output.

```bash
git clone https://github.com/Fanisting/vscode-web-bridge.git
cd vscode-web-bridge
node vsc.mjs pack          # starts the bridge, prints the path of agent-bridge.vsix
```

> Build the VSIX **on the same machine whose Chrome opens the IDE**. The package embeds that machine's
> extension token and is rejected by any other bridge.

### code-server (local or in a remote container)

1. Install `~/.vscode-web-bridge/agent-bridge.vsix` in code-server, using either:
   - drag the file into the Explorer, right-click it, then **Install Extension VSIX**, or
   - `code-server --install-extension agent-bridge.vsix` in the IDE's terminal.
2. Reload the window. The status bar shows **Agent**.
3. If code-server is not on `localhost`, Chrome asks once whether the site may access your local network.
   Click **Allow**.
4. Run `node vsc.mjs clients`. If the list is empty, run `node vsc.mjs ping`. If it reports a rejected origin such as `https://ide.example.com`, allow your IDE once:

   ```bash
   node vsc.mjs allow-origin https://ide.example.com
   ```
5. Run `node vsc.mjs info` to see the workspace, the VS Code version and the terminals.

### vscode.dev / github.dev

1. `node vsc.mjs install-url` prints a URL containing the extension token. Copy it yourself.
2. In vscode.dev press F1, run **Developer: Install Extension from Location...**, and paste the URL.
3. Click **Allow** on Chrome's local network prompt.

Codespaces in the browser should work the same way as code-server, but it is untested.

## Using it from an AI agent

The repository is itself an [Agent Skill](https://docs.claude.com/en/docs/claude-code/skills): `SKILL.md` sits
next to the tool, so installing the skill installs the tool.

```bash
# Claude Code
git clone https://github.com/Fanisting/vscode-web-bridge.git ~/.claude/skills/vscode-web-bridge
# Other agents that read ~/.agents/skills (Codex and others)
git clone https://github.com/Fanisting/vscode-web-bridge.git ~/.agents/skills/vscode-web-bridge
```

For a first-time setup, tell the agent:

> Follow `START.md` in the vscode-web-bridge folder.

`START.md` walks the agent through setup:
1. Build the VSIX.
2. Wait for you to install it.
3. Connect.
4. Allow your IDE's origin, but only after you confirm it.
5. Run a safe smoke test.

After that, the agent uses `SKILL.md` for the full method list, conventions and rules.

Agents without a skill system can read `SKILL.md` directly; it is self-contained.

## CLI

```bash
node vsc.mjs <method> [positional ...] [key=value ...] [--client <id|name>] [--timeout <ms>] [--json]
node vsc.mjs <method> '{"json":"params"}'
```

- **Positionals** fill the method's parameters in order, for example `fs.read path startLine endLine`.
- **`key=value`** counts as a parameter only when `key` is a known parameter name, so
  `terminal.run 'x=7; echo $x'` stays one command. Values are JSON-parsed when possible.
- **`key=@file`** reads a local file as the value, and **`key=@-`** reads stdin. Use these for multi-line content.
- **Output**: strings print raw, lists of strings one per line, objects as JSON. The exit code is 0 or 1. The exception is `terminal.run`: it prints `[exit N]` to stderr and exits with the remote command's code (124 on timeout).

Bridge management: `start`, `stop`, `clients`, `pack [out=file.vsix]`, `install-url`, `origins`,
`allow-origin <origin>`, `help`.

Examples:

```bash
node vsc.mjs info
node vsc.mjs fs.list . depth=2
node vsc.mjs fs.read src/app.py 0 80                       # first 80 lines (0-based, end exclusive)
node vsc.mjs fs.write src/new.py content=@./draft.py
node vsc.mjs editor.open src/app.py 42                      # 1-based line
node vsc.mjs editor.edit '{"path":"src/app.py","edits":[{"line":10,"endLine":12,"text":"x = 1\n"}],"save":true}'
node vsc.mjs terminal.run 'make test' cwd=services/api timeout=600000
node vsc.mjs terminal.send 'npm run dev' name=dev        # long-running process: send, do not wait
node vsc.mjs diagnostics severity=error
node vsc.mjs cmd.list git
node vsc.mjs cmd.run vscode.open uri:src/app.py
node vsc.mjs batch '{"calls":[{"method":"editor.save","params":{"all":true}},{"method":"diagnostics"}]}'
node vsc.mjs eval 'return vscode.workspace.workspaceFolders.map(f => f.uri.toString())'
```

Paths can be given three ways:
- relative to the first workspace folder;
- as `FolderName:rel/path` in multi-root workspaces;
- as full URIs (`vscode-remote://...`).

## Method reference

| Group | Methods |
|---|---|
| Info | `ping`, `info` |
| Files | `fs.read`, `fs.write`, `fs.list`, `fs.stat`, `fs.exists`, `fs.mkdir`, `fs.delete`, `fs.rename`, `fs.copy`, `fs.find`, `fs.grep` |
| Editors | `editor.open`, `editor.text`, `editor.selection`, `editor.select`, `editor.edit`, `editor.replace`, `editor.insert`, `editor.save`, `editor.close` |
| Language | `diagnostics`, `symbols`, `format` |
| Commands | `cmd.run`, `cmd.list` |
| Terminals | `terminal.run`, `terminal.send`, `terminal.list`, `terminal.kill` |
| UI | `notify`, `clipboard.read`, `clipboard.write` |
| Advanced | `eval`, `batch` |

Parameters, defaults and return shapes for each method are in [SKILL.md](SKILL.md#method-reference).

**Line numbers.** These are counted from 1:
- the `line` and `endLine` parameters;
- every line number the bridge prints (grep, diagnostics, symbols).

`fs.read` ranges and `[line, col]` positions are counted from 0.

## HTTP API

The CLI is a thin wrapper. Any language can call the bridge directly:

```http
POST http://127.0.0.1:47821/rpc
x-bridge-token: <contents of ~/.vscode-web-bridge/token>
content-type: application/json

{"method": "fs.read", "params": {"path": "README.md"}, "client": "optional id or name", "timeout": 60000}
```

```json
{"id": "...", "ok": true, "result": "...", "client": "..."}
```

- On failure the response is `{"ok": false, "error": "..."}`.
- `GET /clients` (same header) lists connected windows.
- Requests that carry an `Origin` header are refused, so web pages cannot use this API.
- The bridge waits up to 20 s for a window to connect or reconnect.
- It also extends the request timeout to cover any `terminal.run` timeout in the call.

## Security model

Anyone holding the bridge token gets shell access to your IDE's container. In the vscode.dev fallback, they get shell access to your local machine. The design keeps that power away from web pages and other users.

| Threat | Mitigation |
|---|---|
| Other machines on the network | The bridge binds `127.0.0.1` only. |
| DNS rebinding from a malicious site | The `Host` header must be `localhost` or `127.0.0.1` with the bridge port. |
| A web page calling the agent API | `/rpc` and the management routes require the master token and reject any request with an `Origin` header. |
| A leaked extension token | The extension uses a separate token, `HMAC(master, "vscode-web-bridge/ext/v1")`, which only works on the extension routes and cannot call `/rpc`. |
| A hostile site posting to the extension routes | The server checks the origin. Built-in origins are `localhost`, `vscode.dev`, `github.dev` and `*.vscode-cdn.net`, plus any you add with `allow-origin`. Other origins get 403. |
| Forged results or replies to other clients | Each call gets a random UUID that is bound to the window it was sent to. |
| Arbitrary local execution through the vscode.dev fallback | Local exec only runs a command the agent itself sent through `terminal.run`. It uses a one-time ticket bound to that call. `VSCB_NO_EXEC=1` disables it entirely. |
| Other local users reading the token | `~/.vscode-web-bridge/token` is restricted to the owner (`chmod 600` / `icacls`). |
| Duplicate execution after a reload | Acknowledged messages are never re-delivered (at-most-once). |

It does **not** protect against two things:
- malware already running as your user, which can read the token;
- a compromised IDE origin you allowed, which can use the extension routes.

Treat `allow-origin` as giving that site access to your agent's session. Never commit or share `~/.vscode-web-bridge/` or a built VSIX.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `VSCB_PORT` | `47821` | Bridge port (set it for both `pack` and every CLI call). |
| `VSCB_DEBUG` | unset | `1` logs every request (tokens redacted). |
| `VSCB_QUIET` | unset | `1` silences the bridge log. |
| `VSCB_NO_EXEC` | unset | `1` disables the local exec fallback. |
| `VSCB_SHELL` | `powershell` on Windows, `sh` elsewhere | Shell for the local exec fallback. |
| `VSCB_CWD` | home directory | Working directory for the local exec fallback. |

State lives in `~/.vscode-web-bridge/`:

| File | Contents |
|---|---|
| `token` | Master token (owner-only). To rotate every token: `vsc stop`, delete this file, `vsc pack`, then reinstall the VSIX. |
| `origins` | Extra allowed IDE origins, one per line (managed by `allow-origin`). |
| `agent-bridge.vsix` | Last built package. |
| `bridge.log` | Bridge log when started by the CLI. |

## Limitations

- **Terminal output capture needs shell integration** (VS Code 1.93+, with bash, zsh, fish or pwsh). Without it, the command is still sent but the result says `captured: false`. Redirect the output to a file and `fs.read` it.
- **Restricted Mode blocks terminals.** Trust the workspace folder first.
- **Chrome Local Network Access.** Sites that are not on `localhost` need a one-time Allow. A plain `http://` host on a company network may still be blocked from reaching your machine. Use its `https://` address or the `LocalNetworkAccessAllowedForUrls` Chrome policy.
- **Webviews and custom panels** are not reachable through the API. Use browser automation for those.
- **One machine per VSIX.** The package is bound to the bridge that built it.
- **The tab must stay open.** Closing the tab, or Chrome discarding it to save memory, disconnects the bridge until the page loads again.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no VS Code web client connected` | Open or reload the IDE tab. Check the status bar shows **Agent**. If the error lists a rejected origin, run `allow-origin` for it. |
| Calls hang, then time out | Chrome's local network access was denied, or a plain `http://` host is blocked. See Limitations. |
| Extension output shows `bridge rejected this window (401)` | The VSIX was built on another machine or the token was rotated. Run `pack` here and reinstall. |
| `(403)` in the extension output | The IDE origin is not allowed yet. Run `allow-origin`. |
| `Restricted Mode` error | Trust the folder (`vsc cmd.run workbench.trust.manage`). |
| Old behaviour after editing the extension | `pack`, reinstall, then `vsc cmd.run workbench.action.reloadWindow`. Each build has a unique version, so caches do not interfere. |

The extension also adds three commands to the IDE: **Agent Bridge: Status**, **Reconnect**, and **Pause / Resume**.

## Development

There is no build step. Edit `extension/extension.js`, then repack and reinstall.

A local code-server makes a convenient test target (Linux or WSL):

```bash
curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone
dev/cs_run.sh                                        # code-server on 127.0.0.1:8080, no auth, loopback only
node vsc.mjs pack && dev/cs_install.sh ~/.vscode-web-bridge/agent-bridge.vsix
# open http://localhost:8080 in Chrome, then:
node vsc.mjs info
```

- `dev/memfs-eval.js` registers an in-memory file system (`agentmem:`) through `eval`. It is useful for testing file methods on vscode.dev, which has no backend.
- Tested on Windows 11 with Chrome and Node 24, against code-server 4.141 (VS Code 1.141) in WSL Debian and against vscode.dev.

## License

[MIT](LICENSE)
