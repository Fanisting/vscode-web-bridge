#!/usr/bin/env bash
# Install a freshly packed VSIX into the local test code-server.
# Usage: dev/cs_install.sh /path/to/agent-bridge.vsix   (from WSL: /mnt/c/Users/<you>/.vscode-web-bridge/agent-bridge.vsix)
V=${1:?usage: cs_install.sh path/to/agent-bridge.vsix}
~/.local/bin/code-server --install-extension "$V" --force 2>&1 | tail -3
~/.local/bin/code-server --list-extensions --show-versions
