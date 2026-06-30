#!/usr/bin/env bash
# ADR 0146 Phase 4a — vendor the CPython-WASI runtime for the in-process code-exec sandbox.
# Downloads a PINNED python.wasm (wasi-preview1) + verifies its SHA-256. The Docker image runs
# this (like sync-{schemas,fixtures,packs}.sh); the binary is gitignored, never committed.
set -euo pipefail

VERSION="3.12.0+20231211-040d5a6"
URL="https://github.com/vmware-labs/webassembly-language-runtimes/releases/download/python/3.12.0%2B20231211-040d5a6/python-3.12.0.wasm"
SHA256="e5dc5a398b07b54ea8fdb503bf68fb583d533f10ec3f930963e02b9505f7a763"

DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backend/typescript/vendor"
DEST="${DEST_DIR}/python-3.12.0.wasm"
mkdir -p "${DEST_DIR}"

verify() { echo "${SHA256}  ${DEST}" | shasum -a 256 -c - >/dev/null 2>&1; }

if [[ -f "${DEST}" ]] && verify; then
  echo "python-wasi: present + checksum OK (${VERSION})"
  exit 0
fi

echo "python-wasi: downloading ${VERSION} (~25 MB) ..."
curl -sSL --retry 3 --retry-delay 2 -o "${DEST}" "${URL}"

if ! verify; then
  echo "python-wasi: CHECKSUM MISMATCH — refusing to use the file (supply-chain guard)." >&2
  rm -f "${DEST}"
  exit 1
fi
echo "python-wasi: downloaded + verified (${VERSION})"
