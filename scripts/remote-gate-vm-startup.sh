#!/bin/bash
# ADR 0863 D9 P3: startup script for the remote gate VM (openwop-ci-gate).
# Runs as root at every boot (GCE `startup-script` metadata). Provisions once,
# then on every boot re-asserts sshd's settings and settles jobs a dead runner left.
#
# Inputs (instance metadata, set by the operator; none of them is a secret):
#   openwop-ci-install-b64  base64 tar.gz of the reviewed worker files
#   openwop-ci-install-sha  its sha256 (the startup script refuses a mismatch)
#   openwop-ci-client-key   the gate client's ed25519 PUBLIC key
#   openwop-ci-policy-sha   the runner policy digest the Macs pin
#   openwop-ci-pinned-image / openwop-ci-pinned-playwright
#                           the e2e renderer, from frontend/react/e2e/pinned-browser.json
# Output: guest attribute openwop-ci/host-key = this VM's ed25519 PUBLIC host key,
# read by the operator over the authenticated GCE API and pinned on the Macs.
# The VM's service account has no roles and no scopes; it holds no credentials.
set -euo pipefail
MD=http://metadata.google.internal/computeMetadata/v1/instance
md() { curl -fsS -H 'Metadata-Flavor: Google' "$MD/attributes/$1"; }
NODE_VERSION=22.13.1
NODE_SHA=0d2a5af33c7deab5555c8309cd3f373446fe1526c1b95833935ab3f019733b3b
PLAYWRIGHT_VERSION=1.59.1
CI_HOME=/home/ci
LIBEXEC=/usr/local/libexec
INSTALL=$LIBEXEC/openwop-ci
# Provisioning re-runs on the next boot when this version OR the worker payload's
# sha256 changes, so a new payload needs only a metadata update and a restart
# (every step below is idempotent).
PROVISION_VERSION=11
PROVISION_KEY="$PROVISION_VERSION:$(md openwop-ci-install-sha)"

if [ "$(cat /var/lib/openwop-ci/provisioned-version 2>/dev/null)" != "$PROVISION_KEY" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -yq --no-install-recommends git python3 curl ca-certificates xz-utils \
    openssh-server unattended-upgrades apt-listchanges dbus-user-session \
    lsof procps zip unzip rsync jq bsdextrautils docker.io   # tools the gate's scripts call that the Macs ship
    # with: lsof (port guard, shadow 2026-11-01); rsync (Tracegate ledger sync, shadow 3, 2026-11-02);
    # jq, column (bsdextrautils) (gate scripts)
  # A local git identity is in the gate env below: every Mac that gates has one, and the
  # merge-train self-test's local merges fail without it (shadow 4, 2026-11-02).
  # Security updates daily, no automatic reboot: the VM powers off when idle and
  # boots onto the new kernel at its next gate.
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

  curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA  /tmp/node.tar.xz" | sha256sum -c -
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm -f /tmp/node.tar.xz
  /usr/local/bin/npm install -g npm@10.9.8 --no-audit --no-fund
  [ "$(/usr/local/bin/npm --version)" = 10.9.8 ]
  # OS libraries for Chromium (root); the browser itself is installed per gate
  # into the runner's persistent PLAYWRIGHT_BROWSERS_PATH.
  /usr/local/bin/npx -y "playwright@$PLAYWRIGHT_VERSION" install-deps chromium

  id ci >/dev/null 2>&1 || useradd -m -s /bin/bash ci
  usermod -p '*' ci   # no password, not locked: sshd without PAM refuses a locked account
  install -d -o ci -g ci -m 700 $CI_HOME/gate $CI_HOME/gate/jobs $CI_HOME/gate/spool \
    $CI_HOME/gate/runner $CI_HOME/gate/logs $CI_HOME/.npm $CI_HOME/.cache $CI_HOME/.cache/ms-playwright
  loginctl enable-linger ci   # systemd --user for `systemd-run --user` launches
  # Restart the user manager so it starts with the user D-Bus installed above:
  # without it `systemd-run --user` and the idle query both fail (dry run 2026-11-01).
  systemctl restart "user@$(id -u ci).service"

  md openwop-ci-install-b64 | base64 -d > /tmp/openwop-ci.tgz
  echo "$(md openwop-ci-install-sha)  /tmp/openwop-ci.tgz" | sha256sum -c -
  rm -rf $INSTALL && install -d -m 755 $INSTALL && tar -xzf /tmp/openwop-ci.tgz -C $INSTALL && rm -f /tmp/openwop-ci.tgz
  chown -R root:root $INSTALL && chmod -R go-w $INSTALL
  printf '#!/bin/sh\nexec /usr/local/bin/node %s/remote-gate-worker.mjs\n' $INSTALL > $LIBEXEC/openwop-ci-worker
  chmod 755 $LIBEXEC/openwop-ci-worker

  # ADR 0863 D9 P5: the PINNED renderer for the e2e lane. The image (by digest) and
  # its Playwright version come from metadata, copied from the candidate's
  # frontend/react/e2e/pinned-browser.json. Root runs it; `ci` is NOT in the docker
  # group (that is root-equivalent): the gate only connects to 127.0.0.1:3000.
  PIN_IMAGE="$(md openwop-ci-pinned-image)"; PIN_PW="$(md openwop-ci-pinned-playwright)"
  docker pull -q "$PIN_IMAGE"
  cat > /etc/systemd/system/openwop-ci-pwserver.service <<UNIT
[Unit]
Description=ADR 0863 D9 P5: pinned Playwright browser server for the e2e lane
After=docker.service network-online.target
Requires=docker.service
[Service]
ExecStartPre=-/usr/bin/docker rm -f owci-pwserver
ExecStart=/usr/bin/docker run --rm --name owci-pwserver --init -p 127.0.0.1:3000:3000 -v owci-pw-npm:/root/.npm $PIN_IMAGE /bin/sh -c 'cd /tmp && npx -y playwright@$PIN_PW run-server --port 3000 --host 0.0.0.0'
ExecStop=/usr/bin/docker stop owci-pwserver
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now openwop-ci-pwserver.service

  install -d -m 755 /etc/openwop-ci
  cat > /etc/openwop-ci/worker.json <<EOF
{"root":"$CI_HOME/gate/jobs","spoolRoot":"$CI_HOME/gate/spool","runnerRoot":"$CI_HOME/gate/runner","logRoot":"$CI_HOME/gate/logs",
 "trust":{"runnerId":"openwop-ci-gate","policySha256":"$(md openwop-ci-policy-sha)"},
 "node":"/usr/local/bin/node","installDir":"$INSTALL","launcher":"systemd-run","timing":{"maxMs":7200000},
 "env":{"PATH":"/usr/local/bin:/usr/bin:/bin","npm_config_cache":"$CI_HOME/.npm","PLAYWRIGHT_BROWSERS_PATH":"$CI_HOME/.cache/ms-playwright",
        "GIT_AUTHOR_NAME":"openwop-ci-gate","GIT_AUTHOR_EMAIL":"ci@openwop-ci-gate.invalid",
        "GIT_COMMITTER_NAME":"openwop-ci-gate","GIT_COMMITTER_EMAIL":"ci@openwop-ci-gate.invalid",
        "OPENWOP_E2E_PINNED_WS":"ws://127.0.0.1:3000/",
        "GIT_CONFIG_GLOBAL":"/dev/null","GIT_CONFIG_NOSYSTEM":"1","LANG":"C.UTF-8"}}
EOF
  chmod 644 /etc/openwop-ci/worker.json

  # Settle jobs a dead runner left, at every boot, before any connection.
  cat > /etc/systemd/system/openwop-ci-recover.service <<EOF
[Unit]
Description=ADR 0863 D9: settle remote gate jobs left by a dead runner
After=network-online.target
Before=ssh.service
[Service]
Type=oneshot
User=ci
ExecStart=/usr/local/bin/node $INSTALL/remote-gate-runner.mjs --recover
[Install]
WantedBy=multi-user.target
EOF
  # Power off after 15 idle minutes: no gate unit running and no ci SSH session.
  cat > /usr/local/sbin/openwop-ci-idle <<'EOF'
#!/bin/bash
# Fail closed: only a positive "nothing is running" counts as idle. A failed
# systemd query is busy, never idle (a gate must not be powered off under it).
STAMP=/run/openwop-ci-idle-since
busy=0
units=$(systemctl --machine=ci@ --user list-units --state=active --no-legend 'openwop-gate-*' 2>/dev/null) || busy=1
[ -n "$units" ] && busy=1
pgrep -u ci -f 'remote-gate-(worker|runner)\.mjs' >/dev/null && busy=1
if [ "$busy" = 1 ] || [ ! -f "$STAMP" ]; then date +%s > "$STAMP"; exit 0; fi
[ $(( $(date +%s) - $(cat "$STAMP") )) -ge 900 ] && systemctl poweroff
exit 0
EOF
  chmod 755 /usr/local/sbin/openwop-ci-idle
  printf '[Unit]\nDescription=ADR 0863 D9 idle poweroff check\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/openwop-ci-idle\n' > /etc/systemd/system/openwop-ci-idle.service
  printf '[Unit]\nDescription=ADR 0863 D9 idle poweroff timer\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=1min\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/openwop-ci-idle.timer
  systemctl daemon-reload
  systemctl enable openwop-ci-recover.service openwop-ci-idle.timer

  install -d -m 700 /var/lib/openwop-ci && echo "$PROVISION_KEY" > /var/lib/openwop-ci/provisioned-version
fi

# Every boot: sshd accepts exactly one key, for one forced command, from IAP only.
install -d -m 755 /etc/ssh/authorized_keys
printf 'restrict,command="%s/openwop-ci-worker",from="35.235.240.0/20" %s\n' "$LIBEXEC" "$(md openwop-ci-client-key)" > /etc/ssh/authorized_keys/ci
chmod 644 /etc/ssh/authorized_keys/ci
[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
cat > /etc/ssh/sshd_config.d/00-openwop-ci.conf <<'EOF'
HostKey /etc/ssh/ssh_host_ed25519_key
HostKeyAlgorithms ssh-ed25519
AllowUsers ci
AuthorizedKeysFile /etc/ssh/authorized_keys/%u
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PermitTTY no
DisableForwarding yes
PermitTunnel no
PermitUserEnvironment no
EOF
sshd -t && systemctl restart ssh
systemctl start openwop-ci-idle.timer
curl -fsS -X PUT -H 'Metadata-Flavor: Google' --data "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" \
  "$MD/guest-attributes/openwop-ci/host-key"
