# shellcheck shell=bash
# ADR 0863 D9 — the ONE definition of the remote gate's reviewed payload: which
# files, built reproducibly (`git archive` of a commit's tree). The gate VM is
# provisioned from it (metadata openwop-ci-install-b64/-sha), and the Macs install
# their pinned controller from it (scripts/remote-gate-install-controller.sh). Its
# sha256 is the runner policy pin, so a Mac's controller and the VM's worker are
# the same code by construction (shadow 2, 2026-11-02, ran a newer controller
# against an older worker).
REMOTE_GATE_PAYLOAD_FILES=(
  remote-gate.mjs remote-gate-gate.mjs remote-gate-runner.mjs remote-gate-worker.mjs
  lib/remote-gate-accept.mjs lib/remote-gate-control.mjs lib/remote-gate-controller.mjs
  lib/remote-gate-frame.mjs lib/remote-gate-gcp.mjs lib/remote-gate-job.mjs
  lib/remote-gate-process.mjs lib/remote-gate-publish.mjs lib/remote-gate-result.mjs
  lib/remote-gate-runner.mjs lib/remote-gate-source.mjs lib/remote-gate-ssh.mjs
  lib/remote-gate-status.mjs lib/remote-gate-supervisor.mjs lib/remote-gate-worker.mjs
)

# remote_gate_payload <repo> <commit> <out.tgz>: writes the payload, prints its sha256.
# Built by remote-gate-payload.mjs, not `git archive`: archiving a tree stamps the
# current time into every entry, and `git archive --mtime` needs git >= 2.42 (Apple
# git 2.39 printed usage and wrote nothing, so train 379 went red). The .mjs fixes
# every byte itself, so the sha is the same on any git version and any host.
remote_gate_payload() {
  local repo="$1" commit="$2" out="$3" here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node "$here/remote-gate-payload.mjs" "$repo" "$commit" "$out" "${REMOTE_GATE_PAYLOAD_FILES[@]}"
}
