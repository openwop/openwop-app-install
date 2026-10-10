# @openwop/agent-host — the Claude Code companion (ADR 0785)

Pairs **this machine** with an openwop-app workspace. The app can then show your own
Claude Code as a terminal tab, reach it over MCP, route its permission prompts to
approval cards, and send it tasks from workflows.

**Step-by-step setup guide: [`docs/CLAUDE-CODE-SETUP.md`](../../docs/CLAUDE-CODE-SETUP.md).**

It connects **out** to the app and never opens a listening port. Claude Code keeps running
under whatever credential its own `claude` CLI is signed in with; that credential never
leaves your machine and the app never sees it. Signing Claude Code in with an **Anthropic
API key** (or Bedrock / Vertex) is the supported path; a Claude Free/Pro/Max login is at
your own risk (ADR 0785 D2).

## Requirements

- **Node 22 or newer** (the companion uses Node's built-in WebSocket client).
- **Claude Code** (`claude`) on your PATH. An Anthropic API key (or Bedrock / Vertex) is the
  supported sign-in; a Claude Free/Pro/Max login is at your own risk (ADR 0785 D2).
- **macOS and Windows** install with no build step (node-pty ships prebuilt binaries).
- **Linux** has no node-pty prebuild, so the install compiles it: you need `python3`,
  `make` and a C++ compiler (`build-essential` on Debian/Ubuntu, `gcc-c++ make` on
  Fedora). Pairing works without it; only `run` needs the terminal module.
- **npm 12 blocks dependency install scripts by default.** On Linux that stops
  node-pty from compiling, so allow its script explicitly:
  `npx --allow-scripts=node-pty @openwop/agent-host run` (or once:
  `npm config set allow-scripts=node-pty --location=user`). On macOS and Windows
  npm 12 prints a "scripts blocked" warning for node-pty that you can ignore: the
  prebuilt binary loads without it (verified 2026-10-05).

## Use

```bash
npx @openwop/agent-host pair --host https://your-app.example.com
#   behind a proxy that cannot carry WebSockets (Firebase Hosting's /api rewrite),
#   point --api-base at the backend directly — app.openwop.dev:
npx @openwop/agent-host pair --host https://app.openwop.dev --api-base https://openwop-app-backend-89896419173.us-central1.run.app
#   an API on another origin takes an absolute base (--host stays the app):
npx @openwop/agent-host pair --host https://app.example.com --api-base https://api.example.com

npx @openwop/agent-host status
npx @openwop/agent-host unpair     # forgets locally; revoke the key in the app
```

From a checkout, `node clients/agent-host/src/bin.js <command>` works the same way.

**Direct origin, found automatically (0.1.1+).** Some front doors pass ordinary HTTP
but cannot carry a WebSocket (Firebase Hosting's rewrite drops the `Upgrade`). On every
`pair` and `run`, the companion reads the host's advertised direct origin from
discovery (`/.well-known/openwop`, `extensions["openwop-app.host"].streamBase`) and
uses it for the device socket, MCP and the permission hook. It accepts only an `https`
origin with no credentials or query, and keeps the paired root when nothing valid is
advertised. `run` prints the root it uses (`connecting through …`).

`pair` prints a code and a link. Open the link while signed in, **type the code** (the link
never carries it: a pairing link with a code already in it is a phishing lure), check where
and when the request started, read the consent, and approve; the command finishes by itself.
The Claude Code page in the app prints the exact command for that deploy. The host must have
`OPENWOP_CLAUDE_CODE_AT_OWN_RISK=true` and the `claude-code` toggle on for you.

The key is stored in the macOS keychain, or elsewhere in
`~/.openwop/agent-host/credentials.json` (directory `0700`, file `0600`).
`OPENWOP_AGENT_HOST_HOME` overrides the directory.

**Known exposure (macOS):** `security` takes the secret as a command-line argument, so for
the instant the keychain write runs, another user on the same Mac could read it with `ps`.
`security` has no non-interactive stdin form. A native keychain binding would remove this
at the cost of a compiled dependency (tracked in ADR 0785).

## Host Claude Code sessions

```bash
npx @openwop/agent-host run --root ~/code/my-repo
```

`run` keeps one outbound connection to the workspace and starts `claude` in a terminal
whenever you open a Claude Code tab in the app. Sessions start in `--root` (default: the
current directory) and nowhere else. Closing the app tab stops the session; stopping `run`
(Ctrl+C) stops all of them. Disconnects are routine (the host ends long requests) and the
companion reconnects by itself; a session keeps running across a reconnect, and the tab
catches up from a replay buffer.

## Test

```bash
cd clients/agent-host && node --test
```
