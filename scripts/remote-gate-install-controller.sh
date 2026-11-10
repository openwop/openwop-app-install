#!/usr/bin/env bash
# ADR 0863 D9 P6 — install this Mac's pinned remote-gate controller.
#
#   scripts/remote-gate-install-controller.sh <commit>
#
# Builds the reviewed payload from <commit> (scripts/lib/remote-gate-payload.sh)
# and installs it under ~/.config/openwop-ci/install/<sha256>/ ONLY if that sha256
# equals the policy pin in ~/.config/openwop-ci/runner.json, i.e. the exact code the
# gate VM runs. merge-train runs the controller from there, never from a train's
# candidate tree and never from whatever this checkout happens to hold.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="${OPENWOP_CI_CONFIG_DIR:-$HOME/.config/openwop-ci}"
COMMIT="${1:?usage: remote-gate-install-controller.sh <commit>}"
. "$ROOT/scripts/lib/remote-gate-payload.sh"
PIN="$(node -e "process.stdout.write(require('$CONF/runner.json').policySha256)")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SHA="$(remote_gate_payload "$ROOT" "$COMMIT" "$TMP/payload.tgz")"
if [ "$SHA" != "$PIN" ]; then
  echo "remote-gate-install-controller: payload of ${COMMIT:0:9} is ${SHA:0:12}, but the policy pin is ${PIN:0:12}." >&2
  echo "  Install from the commit the VM was provisioned from, or re-provision the VM and update the pin." >&2
  exit 1
fi
DEST="$CONF/install/$SHA"
rm -rf "$DEST.new"; mkdir -p "$DEST.new" && chmod 700 "$CONF/install" "$DEST.new"
tar -xzf "$TMP/payload.tgz" -C "$DEST.new"
rm -rf "$DEST"; mv "$DEST.new" "$DEST"
echo "installed the remote-gate controller ${SHA:0:12} (from ${COMMIT:0:9}) at $DEST"
