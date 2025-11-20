#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT_DIR"
if [ ! -d debian ]; then
  echo "debian/ directory not found; cannot build package" >&2
  exit 3
fi
if ! command -v dpkg-buildpackage >/dev/null 2>&1; then
  echo "dpkg-buildpackage not installed" >&2
  exit 3
fi
# Build binary packages without signing; caller can sign artifacts later.
dpkg-buildpackage -us -uc -b "$@"
