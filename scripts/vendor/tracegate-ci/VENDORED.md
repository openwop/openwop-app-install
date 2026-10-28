# Vendored: tracegate-ci broker and Red Reader

Byte copies of `src/config.mjs`, `src/broker/*.mjs`, `src/ledger.mjs`, `src/red.mjs` and
`agents/red-reader.md` from
github.com/davidscotttufts/tracegate-ci at `450c2ac` (v0.5.0), Apache-2.0 (LICENSE, NOTICE).
Used by `scripts/lib/broker-observe.sh` (ADR 0974) and `scripts/tracegate.mjs red` (ADR 0980 P1). Do not edit here: change it
upstream, re-copy, and regenerate the manifest below (`scripts/test-broker-observe.mjs` checks it).

**The machine's broker server runs from its own worktree** (2026-10-26):
`<checkout>-broker` (here `~/dev/openwop-app-broker`), detached at `origin/main`.
A server keeps the code it started with, and any client can start one from any
tree; one started from a stale checkout ignored `--yield` (ADR 0974 correction).
So: never delete that worktree while a server runs from it, and after a change to
these files, fast-forward it and restart the server BY PID in a gap with no train
registered (`node scripts/vendor/tracegate-ci/src/broker/main.mjs queue`). The
daemon's `broker_stale` refuses a lease from a server whose `core.mjs` differs.

```
eb72d145fd214272abc0a60690308f3468b122a84a33089f42e2fae3fdf6883f  src/config.mjs
76e1ddb7eb6ca7e9cb18d8134f39f5f83ecb6e8a7025768148adc7f04ed645cd  src/broker/adapt.mjs
0853f31206d89dbd3dcc2303fc4b471c5d2186bd2c0285ea2093b0d34b23c4b9  src/broker/client.mjs
9d0f0c029db7b2f0f4b4365155b1bf952fe124616c8c2b3d5bba51ffc6771c35  src/broker/core.mjs
ca467c2f1852e9969677e325f189b440558988ac294524d5bb4918743534d53d  src/broker/main.mjs
a22baca48c70c03f8bba9175282a0e196621a3f4e2dcc974a31d1f2b9876baca  src/broker/observed.mjs
e0e449ce9dcdf722ab590c427dd40a141232a730525892c9b09b46bec86a452f  src/broker/paths.mjs
62409448524614cb8bf86c29b0ce9ea82deb09274f86b4a4ded51e182ba6a907  src/broker/sampler.mjs
f50ea31d50f609120576790a741cded66e460c334a6f3f8a349ec491caa10dc7  src/broker/server.mjs
14683780a847bc0142d5e34c94adda650243a110e9c11b97eef3296ea7d0ee0a  src/ledger.mjs
ac26456124ecf6b65fbc71b3756480609600e075f608350403cb278fd1dd1bb1  src/red.mjs
c4c4634e8ad21746859c2fb01eeb518120ec5e0f98279225c6253f83e947a818  agents/red-reader.md
```
