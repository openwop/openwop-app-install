# Set up Claude Code

Use the Claude Code on your own machine from inside openwop-app. It appears as a terminal
tab in the AI chat. It can read and add to your to-do board. You can answer its
permission prompts from your inbox, even from your phone, and workflows can send it
coding tasks.

Claude Code keeps running **on your machine**, in a folder you choose, signed in however
you already sign it in. A small companion app, `@openwop/agent-host`, connects your
machine **out** to the workspace. It never opens a port on your machine, and your Claude
credential never leaves it.

- **Users:** start at [Before you start](#before-you-start).
- **Operators** enabling this for a deploy: see [For operators](#for-operators).
- **Design and security model:** see [ADR 0785](adr/0785-claude-code-local-agent-host.md).

## Before you start

You need:

- **Node.js 22 or newer.** Check with `node --version`.
- **Claude Code** installed, and signed in on the same machine (`claude` on your PATH).
  - **Supported:** an Anthropic API key, Amazon Bedrock or Google Vertex.
  - **At your own risk:** a Claude Free, Pro or Max login. Read the consent text on the
    approval page before you use one.
- The **Claude Code** feature switched on for you. If there's no **Claude Code** entry in
  the app, ask your workspace admin.
- **Linux only:** a build toolchain for the terminal module. On Debian or Ubuntu that's
  `sudo apt install build-essential python3`; on Fedora, `sudo dnf install gcc-c++ make
  python3`. macOS and Windows need nothing extra.
- **Linux with npm 12 or newer:** npm now blocks dependency install scripts, so add
  `--allow-scripts=node-pty` to the `npx` commands below (for example
  `npx --allow-scripts=node-pty @openwop/agent-host run`), or allow it once with
  `npm config set allow-scripts=node-pty --location=user`. On macOS and Windows you can
  ignore npm 12's "install scripts blocked" warning for node-pty.

## 1. Pair your machine

Open **Claude Code** in the app (`/claude-code`) and copy the pairing command it shows.
It's already filled in for your deploy. For app.openwop.dev it's:

```bash
npx @openwop/agent-host pair --host https://app.openwop.dev --api-base https://openwop-app-backend-89896419173.us-central1.run.app
```

The command prints an eight-character code like `BCDF-GH23`, plus a link.

1. Open the link while you're signed in to the app.
2. **Type the code yourself.** A genuine link never contains the code. If someone sends you
   a pairing link with a code already filled in, don't approve it.
3. Check the device name, where the request started and which workspace it joins.
4. Read **Before you approve**, tick the box, and choose **Approve device**.

Your terminal finishes on its own within a few seconds and prints `Paired.`. The device
key is stored in the macOS keychain, or on other systems in
`~/.openwop/agent-host/credentials.json` (readable only by you).

Codes expire after ten minutes. If yours expires, run the command again.

## 2. Start the companion

Start the companion in the folder you want Claude Code to work in:

```bash
npx @openwop/agent-host run --root ~/code/my-project
```

Keep it running. Claude Code sessions start in `--root` and nowhere else; if you leave
`--root` out, they start in the current folder. Press Ctrl+C to stop the companion and
every session it hosts.

## 3. Open Claude Code in the chat

1. Open the **Chat**, choose **New tab**, then **Claude Code**.
2. Pick your device and choose **Start Claude Code**.
3. Use it exactly as you would in your own terminal.

Some things to know about the tab:

- **Closing the tab** stops that session. **Disconnects** are routine: Claude Code keeps
  running on your machine, and the tab catches up when you choose **Reconnect**.
- The command palette has an **Open in Claude Code** action. It opens a new Claude Code tab
  already pointed at what you're looking at.
- **No device online?** The tab tells you to run `openwop-agent-host run` on your machine.

## 4. Let Claude Code use your workspace

Sessions started from the app are already connected to your workspace over MCP. Claude
Code can:

| Tool | What it does |
|---|---|
| `claude-code-my-todos` | Lists the to-dos on your board |
| `claude-code-add-todo` | Adds a to-do to your board |
| `claude-code-schema-lookup` | Looks up a workflow, node or envelope schema |

Try asking: *"What's on my to-do list?"* or *"Add a to-do to review this PR tomorrow."*

## 5. Approve permission prompts from anywhere (optional)

Before you start a session, tick **Approve permission prompts from anywhere**. Each time
that session asks to use a tool, an **Allow / Deny** card also appears in your **Inbox**,
so you can answer from your phone.

Whichever answer arrives first wins: the card or the terminal. If nobody answers within
five minutes, the terminal asks you instead. These cards are **yours only**; nobody else in
the workspace can answer them, and neither can a device key.

## 6. Send it work from a workflow (advanced)

A workflow step can hand a coding task to your Claude Code. In the workflow builder it is
the **Ask Claude Code** step (type `claude-code.task`): fill in **Task**, and optionally
**Max turns** and **Deadline**. The gallery template **Ask Claude Code to make a change**
is a ready-made one-step workflow.

**First, allow it per device.** Pairing lets a device run a terminal; it does not let
workflows send it work. On the Claude Code page (`/claude-code`), choose **Allow…** in the
**Workflow tasks** column for the device that should take tasks, and confirm. **Turn off**
stops it at once. A device key can never turn this on for itself.

- With no device allowed, the step fails with `consent_required`.
- The companion must be running with `run` when the step fires. If no allowed device is
  online, the step fails with `runner_unavailable`.
- The task runs **headless** in your `--root` folder, and it may edit files there.
- Its permission prompts become Inbox cards.
- The step waits without holding any server resources. The default wait is 30 minutes; the
  maximum is 120.
- If your machine disappears mid-task, the step ends as `maybe_executed`. It is **never
  retried automatically**, because the task may already have changed files, so you decide
  what happens next.
- The result comes back as untrusted text, clearly fenced, so the workflow never mistakes
  it for instructions.

## Managing and removing devices

`/claude-code` lists your paired devices, their status, and when each was last used.

- **Revoke a device:** choose **Revoke**. It stops working on its next request. Claude Code
  on that machine is unaffected; it just can't reach the workspace any more.
- **Forget the pairing on the machine itself:** run `npx @openwop/agent-host unpair`. This
  doesn't revoke the key, so revoke it in the app as well.
- **Check a machine:** run `npx @openwop/agent-host status`.

## Troubleshooting

| You see | What to do |
|---|---|
| No **Claude Code** entry in the app | The feature is off for you. Ask your admin (see [For operators](#for-operators)). |
| `Claude Code is not available on this host.` | The deploy's operator gate is off. See [For operators](#for-operators). |
| `That code is not valid` | The code expired or was already used. Run `pair` again. |
| The tab says no device is online | Start `npx @openwop/agent-host run` on your machine. Its second line, `connecting through …`, should name the backend directly (on app.openwop.dev, a `…run.app` address). From 0.1.1 the companion finds that address itself on every start; on 0.1.0, run `npx @openwop/agent-host@latest run`, or pair again with the command the Claude Code page shows. |
| `Not paired.` | Run `pair` first, or check `status`. |
| Install fails on Linux building `node-pty` | Install the build toolchain listed in [Before you start](#before-you-start). |
| `posix_spawnp failed` on macOS | Run the companion through `npx @openwop/agent-host`, which repairs the terminal helper's permissions. Don't `require('node-pty')` yourself. |

## Security in one paragraph

The companion only ever connects **out**, with a device key scoped to your workspace. The
key never grants `approvals:respond`, so a device can't approve its own permission prompts.
Your Claude credential stays in Claude Code on your machine. The app never receives,
stores or forwards it. Terminal sessions start only inside `--root`. Revoking the device in
the app cuts it off on its next request.

## For operators

Claude Code is **off by default** and needs two switches.

1. **Operator gate**, for each deploy. While it's off, every Claude Code route returns a
   uniform 404, including the public pairing endpoints. On Cloud Run, use a merge update
   so the rest of the configuration is kept:

   > **A bare `gcloud run services update` does not take effect here (CE-16, 2026-10-05).**
   > `scripts/deploy.sh` routes traffic BY NAME, so the service's traffic spec pins one
   > revision and any `services update` mints a new revision that receives **0%
   > traffic** — the change never reaches a request, and gcloud's success line does not
   > say so. Run it through **`scripts/update-env.sh KEY=VALUE …`** (other flags after
   > `--`, e.g. `-- --update-secrets=NAME=secret:latest`), which verifies the new
   > revision (Ready, same commit, every value) and shifts 100% to it by name. If you
   > run gcloud directly, follow it with
   > `gcloud run services update-traffic <service> --to-revisions <new-revision>=100`.

   ```bash
   scripts/update-env.sh OPENWOP_CLAUDE_CODE_AT_OWN_RISK=true
   ```

2. **The `claude-code` feature toggle** (`bucketUnit: user`). To start with a small group,
   set `status: 'beta'` **and** a non-empty `betaCohort` of workspace ids, using
   `PUT /v1/host/openwop-app/feature-toggles/admin/configs/claude-code` as a super-admin.

   **Do not** use the Feature toggles panel's **Beta** button for this. `beta` with no
   cohort is an open beta for everyone. Use workspace ids rather than principal ids in the
   cohort.

The MCP tools also need `OPENWOP_MCP_SERVER_ENABLED=true`.

**Rollback:**

- **Immediate:** set the toggle back to off. It takes effect per request.
- **Full:** `scripts/update-env.sh OPENWOP_CLAUDE_CODE_AT_OWN_RISK=false` (the gate is on
  only for exactly `true`).

The full rollout runbook is in ADR 0785 § "Turn-on preparation", covering the smoke test
and the database-load watch.
