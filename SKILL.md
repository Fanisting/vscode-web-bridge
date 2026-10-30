---
name: vscode-web-bridge
description: Control a browser VS Code (code-server in a company container, vscode.dev, github.dev, Codespaces) that the user has open in Chrome, from a local coding agent, through a localhost bridge. Read, write, grep and move files in the remote workspace; open and edit editors; run any VS Code command; run shell commands in the remote terminal and get output plus exit code; read diagnostics and symbols; run JS against the VS Code extension API. Use whenever the user asks you to work in their code-server, web IDE, container IDE or "the VS Code in my browser".
---

# VS Code Web Bridge

You drive the user's browser VS Code through its real extension API. Each call is one HTTP round trip
(about 300 ms), far faster and more reliable than screenshots and clicks.

```
you ── CLI/HTTP ──▶ bridge (127.0.0.1:47821, this machine) ◀── long-poll ── "Agent Bridge" extension
                                                                (runs in the Chrome tab's VS Code)
                                                                        │
                                                                        ▼
                                                     remote files, terminals, editors, commands
```

The extension runs inside Chrome, so it reaches this machine's localhost even when the container cannot.
Everything you do lands in the container the IDE is attached to, not on this machine (exception: plain
vscode.dev with no backend, see Terminals).

## 0. Setup check (do this first, every session)

The tool ships **in the same folder as this SKILL.md**: `vsc.mjs`, `bridge.mjs`, `pack.mjs` and
`extension/`. It needs only Node 18+ (no npm install). If those files are missing, the user copied only the
SKILL.md; ask them for the whole folder, or clone https://github.com/Fanisting/vscode-web-bridge.

The bridge and the VSIX must come from **the same machine**: the one whose Chrome opens the IDE. A VSIX built on
another computer carries that computer's token and is rejected (401). On a new machine, always run `$VSC pack`
there and reinstall (section 1).

```bash
VSC="node <this skill folder>/vsc.mjs"   # e.g. node C:/Users/me/.claude/skills/vscode-web-bridge/vsc.mjs
$VSC clients        # connected IDE tabs; the CLI starts the bridge automatically if needed
$VSC info           # workspace folders, remoteName, VS Code version, trusted, active editor, terminals
```

- `clients` shows an entry with `"alive": true`: you are connected. Go to section 2.
- Empty list: see section 1. Never guess; the error text of any call names the cause.

## 1. One-time install (only if `clients` is empty)

1. `$VSC pack` starts the bridge if needed and writes `~/.vscode-web-bridge/agent-bridge.vsix`. The VSIX is tied
   to the bridge on **this** machine (it embeds this machine's extension token), so build it on the machine whose
   Chrome opens the IDE. If the user already installed a VSIX from elsewhere, the new one simply replaces it.
2. The user installs it in code-server: drag the file into the Explorer, right-click, *Install Extension VSIX*
   (or `code-server --install-extension agent-bridge.vsix` in the IDE terminal), then reloads the window.
   The status bar then shows `Agent`.
3. If any call fails with "Requests from these origins were rejected: https://...", that origin is the IDE.
   **Ask the user to confirm** it is their IDE, then run `$VSC allow-origin https://that-origin`.
   localhost, vscode.dev, github.dev and *.vscode-cdn.net are allowed by default.
4. For a non-localhost IDE, Chrome shows a "local network access" prompt the first time. **The user** clicks
   Allow; never click browser permission prompts yourself. If calls still hang on a plain `http://` company
   host, the user should open the IDE's `https://` URL or add it to Chrome's `LocalNetworkAccessAllowedForUrls`
   policy.

vscode.dev / github.dev instead: the user runs `$VSC install-url`, copies the URL, and pastes it into
F1 > *Developer: Install Extension from Location...*.

## 2. Calling methods

```bash
$VSC <method> [positional args] [key=value ...] [--client <id|name>] [--timeout <ms>] [--json]
$VSC <method> '{"json":"params"}'         # one JSON object instead, safest for complex input
```

- Bare arguments fill the method's parameters in order (listed below).
- `key=value` is a parameter only when `key` is a known parameter name, so `terminal.run 'x=7; echo $x'`
  stays one command. Values are JSON-parsed when possible (`true`, `5`, `[...]`).
- `key=@file` reads a local file as the value; `key=@-` reads stdin. Use this for multi-line content.
- Strings print raw; objects print as JSON. Exit code is 0 on success, 1 on error, and for `terminal.run`
  it equals the remote command's exit code (124 on timeout).
- `--client` picks a tab when several are connected (default: the most recently focused one).

### Paths
Relative to the first workspace folder (`src/app.py`); `FolderName:rel/path` in multi-root workspaces;
or a full URI copied from `info` (`vscode-remote://...`).

### Line numbers (two conventions, mind which one)
- **1-based, inclusive**: the `line` / `endLine` params of `editor.open`, `editor.select` and `editor.edit`,
  and every line number the bridge prints (`fs.grep`, `diagnostics`, `symbols`). So a grep hit
  `src/a.py:42: ...` opens with `editor.open src/a.py 42`.
- **0-based**: `fs.read` ranges (`fs.read f 0 80` returns the first 80 lines; end is exclusive), and
  `[line, col]` positions in `start` / `end` / `at` and in `editor.selection` output.

### Method reference

| Method | Positional args | Other params | Returns |
|---|---|---|---|
| `ping` | | | `{pong, client}` |
| `info` | | | folders, remoteName, version, trusted, activeEditor, openTabs, terminals |
| `fs.read` | path, startLine, endLine | `fromEditor` (default true: unsaved editor text wins) | text |
| `fs.write` | path, content | `open`, `append` | `{path, bytes}` (creates parent dirs) |
| `fs.list` | path | `depth` (1), `max` (2000) | relative paths, dirs end in `/` |
| `fs.stat` / `fs.exists` / `fs.mkdir` | path | | `{type, size, mtime}` / bool / `{ok}` |
| `fs.delete` | path | `recursive` (true), `useTrash` (false) | `{ok}` |
| `fs.rename` / `fs.copy` | from, to | `overwrite` | `{ok}` |
| `fs.find` | include (glob) | `exclude`, `max` (500) | paths |
| `fs.grep` | pattern, include | `regex`, `ignoreCase`, `exclude`, `maxMatches` (300) | `"path:line: text"` strings (literal match unless `regex=true`) |
| `editor.open` | path, line | `column`, `preview`, `preserveFocus` | `{path, languageId}` |
| `editor.text` | | `path` (default active) | text, including unsaved edits |
| `editor.selection` | | | `{path, selections:[{start,end,text}]}` |
| `editor.select` | line, endLine | `path`, or `start`/`end` as `[line,col]` | `{selected}` text |
| `editor.edit` | | `path`, `edits`, `save` | `{ok, path, dirty}` |
| `editor.replace` | find, replace | `path`, `regex`, `all` (true), `ignoreCase`, `save` | `{replaced, path}` |
| `editor.insert` | text | `path`, `at` `[line,col]` (default: replaces the selection) | `{ok}` |
| `editor.save` / `editor.close` | | `path` or `all=true` | `{ok}` |
| `diagnostics` | path | `severity` (error, warning, info, hint) | `"path:line:col severity message [source]"` strings |
| `symbols` | path | | indented `"Kind name :line"` strings |
| `format` | path | `save` | `{edits}` count |
| `cmd.list` | filter | | command ids |
| `cmd.run` | command, then args | `args` array | command result |
| `terminal.run` | command | `name` (agent), `cwd`, `timeout` ms (60000), `show`, `local`, `shell` | `{output, exitCode, timedOut, cwd, captured}` |
| `terminal.send` | text | `name`, `enter` (true) | `{ok}`, fire and forget |
| `terminal.list` / `terminal.kill` | name | | terminals / `{ok}` |
| `notify` | message | `level` (info, warning, error) | `{ok}` |
| `clipboard.read` / `clipboard.write` | text | | text / `{ok}` |
| `eval` | code | any extra params, visible as `params` | serialized return value |
| `batch` | | `calls:[{method,params}]`, `stopOnError` | `[{ok, result or error}]` in one round trip |

`$VSC help` prints the same list.

## 3. Recipes

```bash
# orient
$VSC info
$VSC fs.list . depth=2
$VSC fs.grep "def train" include="**/*.py"

# read and edit
$VSC fs.read src/train.py 0 80                    # first 80 lines (0-based, end exclusive)
$VSC editor.replace path=src/train.py find="lr=1e-3" replace="lr=3e-4" save=true
# replace lines 10..12 (1-based, inclusive) with one line; end the text with \n
$VSC editor.edit '{"path":"src/train.py","edits":[{"line":10,"endLine":12,"text":"x = 1\n"}],"save":true}'
# insert at an exact position (0-based [line, col])
$VSC editor.edit '{"path":"src/train.py","edits":[{"start":[0,0],"text":"import os\n"}],"save":true}'
$VSC fs.write src/new_module.py content=@/local/tmp/new_module.py

# run things in the remote shell
$VSC terminal.run 'python3 -m pytest -q'                 # exit code passes through
$VSC terminal.run 'python3 train.py --epochs 1' timeout=1800000
$VSC terminal.run 'make' cwd=services/api name=build    # named terminals persist between calls
$VSC terminal.send 'tensorboard --logdir runs' name=tb  # long-running server: send, do not wait

# check results
$VSC diagnostics severity=error
$VSC batch '{"calls":[{"method":"editor.save","params":{"all":true}},{"method":"diagnostics","params":{"severity":"error"}}]}'

# "click" anything: every menu item and button is a command
$VSC cmd.list git
$VSC cmd.run workbench.action.files.saveAll
$VSC cmd.run vscode.open uri:src/app.py        # uri:<path> or {"$uri":"<path>"} becomes a vscode.Uri
$VSC cmd.run workbench.action.reloadWindow

# escape hatch: full VS Code API
$VSC eval 'return vscode.workspace.textDocuments.map(d => d.uri.toString())'
```

Prefer `fs.*` and `editor.*` over `cat`, `sed` or heredocs in the terminal: they are exact, avoid shell
quoting, and keep open editors in sync. Use the terminal for builds, tests, git, package managers and
anything that needs the remote environment.

## 4. Terminals

- Output and exit code are captured through VS Code shell integration (VS Code 1.93 or newer, bash, zsh,
  fish, pwsh). If `captured` is `false`, the text was sent but output is unavailable: redirect to a file
  (`cmd > /tmp/out.txt 2>&1`) and `fs.read` it with a full `vscode-remote://` URI or a workspace path.
- The first command in a terminal `cd`s into the workspace root, because rc files often `cd` elsewhere.
  `cwd=` sets the directory explicitly (workspace-relative).
- Restricted Mode (untrusted folder) blocks terminals. Ask the user to trust the folder.
- A command still running at `timeout` returns `timedOut: true`, exit 124, and keeps running in the
  terminal. Stop it with Ctrl+C, `$VSC terminal.send '{"name":"agent","text":"\u0003","enter":false}'`,
  or close the terminal with `$VSC terminal.kill agent`.
- Plain vscode.dev / github.dev have no backend: there `terminal.run` executes **on this local machine**
  (PowerShell on Windows; `shell=bash|cmd|pwsh|sh`) and mirrors output into an `agent (local)` terminal.

## 5. Raw HTTP (for agents that prefer it over the CLI)

```
POST http://127.0.0.1:47821/rpc
x-bridge-token: <contents of ~/.vscode-web-bridge/token>
content-type: application/json

{"method":"fs.read","params":{"path":"README.md"},"client":"optional id or name","timeout":60000}
→ {"ok":true,"result":...,"client":"..."}   or   {"ok":false,"error":"..."}
```

Do not send an `Origin` header (requests with one are refused). `GET /clients` with the same header lists tabs.
The bridge waits up to 20 s for a tab to reconnect, and extends the request timeout to cover any
`terminal.run` timeout it carries.

## 6. Rules

- **Never print, log, paste or commit tokens**: `~/.vscode-web-bridge/token`, the install URL, or the VSIX
  contents. Never type them into a web page yourself.
- Run `allow-origin` only after the user confirms the origin is their IDE.
- Never click Chrome permission prompts; the user does.
- Destructive remote actions (`fs.delete`, `rm -rf`, `git push --force`, dropping databases) need the
  user's explicit go-ahead, as they would locally. The container is real.
- Delivery is at most once: a call is retried on another tab only if it never reached the first one, so
  a reload never runs a command twice. After a timeout, check state (`terminal.list`, `fs.exists`) before
  re-running.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `no VS Code web client connected` | Tab closed or asleep, extension not installed, or origin not allowed (error lists it). Ask the user to open or reload the IDE tab. |
| Calls hang, then time out | Chrome local network access was denied, or a plain `http://` host is blocked; see section 1 step 4. |
| Extension output says "bridge rejected this window (401)" | VSIX built on a different machine or the token was reset; run `$VSC pack` here and reinstall. With 403 the origin is not allowed; see section 1 step 3. |
| `Restricted Mode` error | User trusts the folder (`$VSC cmd.run workbench.trust.manage` opens the dialog). |
| Changes to `extension/extension.js` not live | `$VSC pack`, reinstall the VSIX, `$VSC cmd.run workbench.action.reloadWindow`. |
| Anything else | `~/.vscode-web-bridge/bridge.log`; restart with `$VSC stop` then `$VSC start` (set `VSCB_DEBUG=1` for request logs). |
