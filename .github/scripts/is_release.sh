#!/usr/bin/env bash
# Release gate for the preflight job in release.yml: prints "true" when .changeset/ holds a pending
# changeset. With nothing pending, a dispatch runs green and publishes nothing.
set -euo pipefail
count=$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' | wc -l | tr -d ' ')
[ "$count" -gt 0 ] && echo "true" || echo "false"
