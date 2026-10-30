# START HERE (instructions for the agent)

The user wants you to control their browser VS Code (code-server in a company container, open in Chrome)
with the tool in this folder. Follow these steps in order. Steps marked **USER** are the user's to do: tell
them exactly what to do, then wait for them to say it is done. Never print or paste tokens.

## Step 1. Find the tool and check Node

- `THIS` = the folder containing this START.md (it also holds `vsc.mjs`, `bridge.mjs`, `pack.mjs`, `extension/`,
  `SKILL.md`). If those files are missing, stop and ask the user to copy the whole folder.
- Run `node --version`. It must be 18 or newer. If Node is missing or older, stop and tell the user.
- Use `VSC="node <THIS>/vsc.mjs"` for every command below (forward slashes work on Windows).

## Step 2. Build the extension for this machine

```bash
$VSC pack
```

This starts the local bridge (127.0.0.1:47821) and prints the path of a new `agent-bridge.vsix`, usually
`~/.vscode-web-bridge/agent-bridge.vsix`. The VSIX is tied to this machine's bridge, so any VSIX built
elsewhere will not work and must be replaced. Rebuilding is always safe.

## Step 3. **USER** installs the VSIX in code-server

Tell the user, with the real path from Step 2:

> 1. In the container's code-server tab, drag `<path>/agent-bridge.vsix` into the Explorer.
> 2. Right-click it and choose **Install Extension VSIX** (this replaces any older copy).
> 3. Reload the window (F1, then "Developer: Reload Window").
> 4. If Chrome asks to allow access to the local network, click **Allow**.
> 5. Keep that tab open.

Wait until the user confirms.

## Step 4. Connect

```bash
$VSC clients
```

- A client with `"alive": true` appears: go to Step 5.
- Empty list: run `$VSC ping`. Its error message says why.
  - It lists **rejected origins** (for example `https://xxx.company.com`): ask the user "Is `<origin>` your
    code-server address?" Only after they say yes, run `$VSC allow-origin <origin>`, wait 15 seconds, and run
    `$VSC clients` again.
  - No rejected origin listed: ask the user to check that the status bar shows `Agent`, that they clicked
    Allow on Chrome's local network prompt, and to reload the tab. If the IDE URL is plain `http://` on a
    company host, ask them to try the `https://` address. Check `~/.vscode-web-bridge/bridge.log`.

## Step 5. Smoke test (safe, read-mostly)

```bash
$VSC info                                   # note workspaceFolders, version, trusted
$VSC fs.list . depth=1
$VSC terminal.run 'echo bridge-ok && pwd'   # expect output "bridge-ok" and exit code 0
```

- If `trusted` is false or `terminal.run` mentions Restricted Mode, ask the user to trust the folder.
- If `terminal.run` returns `captured: false`, the container's VS Code is older than 1.93: commands still run,
  but read their output by redirecting to a file and using `fs.read` (see SKILL.md).
- Any write test goes in a throwaway folder (for example `bridge_test/`). Ask before deleting it.

Report to the user: connected, workspace folder, VS Code version, and whether terminal output is captured.

## Step 6. Do the real work

Read `SKILL.md` in this folder for every method, the line-number conventions, recipes and rules. In short:

- `fs.*` for files, `editor.*` for edits, `terminal.run` for builds, tests and git,
  `cmd.run` for anything that is a button or menu item.
- Everything happens inside the container. Ask before destructive actions (deletes, force pushes, dropping data).
- Never print or share `~/.vscode-web-bridge/token`, the VSIX contents, or install URLs.
