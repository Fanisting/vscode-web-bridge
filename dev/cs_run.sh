#!/usr/bin/env bash
# Local test code-server: loopback only, no auth (test instance, never expose it).
# Install code-server first: curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone
mkdir -p ~/cs-test
exec ~/.local/bin/code-server --bind-addr 127.0.0.1:8080 --auth none --disable-telemetry ~/cs-test
