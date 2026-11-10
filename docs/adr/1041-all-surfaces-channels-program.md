# ADR 1041 — every surface, the OpenClaw way: a hosted gateway, a device relay and one channel core

Status: Accepted (David, 2026-11-03: "1. yes, and 2. yes... do the full implementation of all of these features in waves").

## Context

On 2026-11-03 a MyndHyve capabilities film asked for every surface the app talks
through to be production grade before it publishes. A read-only audit of `main`
(0cb39beb0) found ten surfaces that were demo or partial:

1. Personal messengers (WhatsApp, Signal, iMessage, Discord) ran only through the
   openwop-cli relay. Its default reply workflow is `openwop-app.uppercase`, it has
   no inbound dedup, no reconnect watchdog, no installer and no settings UI.
2. Telegram and Discord webhooks verify signatures, but neither provider has a
   registry entry, so neither can be configured. There is no reply transport:
   `setMessagingTransport` and `sendOutbound` have no production caller.
3. Slack replies only through the `slack-message` workflow node.
4. Teams only receives approval cards, and those name a provider (`microsoft365`)
   that the registry does not have.
5. No phone calls. `core.openwop.integration` has `voiceCallPlace` and
   `voiceCallTtsGreet`, and both throw `HOST_CAPABILITY_MISSING`.
6. Computer use resolves to a mock or a 501 (ADR 0418 is external-dependency gated).
7. The MCP and A2A servers are env-gated off. The A2A server falls back to tenant
   `default` and principal `anon`, has no A2A rate limit, and four of its surface
   methods are stubs.
8. Desktop (Electron) and iOS (WKWebView) are unsigned shells.
9. SKILL.md skills can be converted (`packs/core.openwop.skills-bridge`, RFC 0131
   Accepted) but not imported.
10. WhatsApp, voice, Claude Code, the marketplace UI and email campaigns are off by
    default.

The user's direction was to support all of them the way OpenClaw does. The
earlier MyndHyve Relay Agent plan (`myndhyve/docs/plans/myndhyve-cli-implementation.md`,
2026-02-15) already borrowed OpenClaw's design for the personal messengers. That
relay never closed its loop either: `queueRelayOutbound` had no non-test caller,
so agent replies never reached WhatsApp, Signal or iMessage.

OpenClaw (docs.openclaw.ai, read 2026-11-03) runs one gateway process per
operator. It states it is not a boundary between mutually adversarial users, its
sandbox is off by default, CVE-2026-25253 let a URL-supplied gateway address leak
the gateway token, and its ClawHub skills registry was poisoned in February 2026
(341 malicious skills of 2,857, delivering a macOS infostealer).

## Decision

### D1. Two lanes, one channel core

- **Hosted gateway** (the Cloud Run backend, multi-tenant). Channels with an
  official bot or webhook API, credentials per tenant through the connections
  broker (ADR 0024/0780): Telegram, Slack, Discord, Teams, Google Chat, WhatsApp
  through the official business API, SMS, email, web chat, phone calls, and a
  hosted browser over remote CDP.
- **Device relay** (openwop-cli on the user's own machine, later bundled in the
  desktop app). Channels that exist only as a personal account on a device:
  personal WhatsApp (Baileys), iMessage (`imsg rpc` on a signed-in Mac), Signal
  (signal-cli), and the user's own Chrome.
- **Channel core.** Both lanes feed one ingress into the main chat's
  conversations (ADR 0154), under one DM pairing, allowlist and mention policy,
  one reply transport, one inbound dedup and one per-connection rate limit, with
  one channels settings page. No lane gets its own conversation store.

### D2. The device lane reverses MyndHyve decision 6(e), on OpenClaw's terms

`docs/steward/MYNDHYVE-DECISIONS.md` 6(e) (2026-07-17) said "WhatsApp ONLY via
the official BSP channel; DROP iMessage and all unofficial bridges". The user
reversed it on 2026-11-03 for a personal device lane, with these terms:

- Each user opts in. The lane is off for every tenant until a user sets it up.
- It runs only on the user's own machine and the user's own accounts. Never on a
  number or account the operator owns.
- Setup shows the risk before linking: a WhatsApp number linked through Baileys
  can be banned, and Apple has broken reverse-engineered iMessage clients before.
- Business WhatsApp stays on the official API only (ADR 0394, `OPENWOP-WHATSAPP.md`).
- A relay token is bound to one tenant, one user and one device. The relay never
  takes its server address from a link or a query string (the CVE-2026-25253
  lesson).

### D3. Security floor for every lane

Default-deny DMs (pairing or allowlist), mention-gated groups, signature checks on
every hosted webhook, idempotency on every inbound message and every send, the
existing approval gate on side effects, and the code sandbox on. Skills install
only signed and scanned (D4 of ADR 1044).

> **CORRECTED 2026-11-03 (ADR 1044 D1–D4):** "signed and scanned" was too strong
> for imports. A SKILL.md import has no publisher signature, so it never enters the
> signed pack lane. It installs as an unverified agent owned by one workspace,
> after a scan, an admin-only preview and an approval of the exact bytes. It is
> never published. Marketplace packs stay signed-only. ADR 1044 D4 states the rule:
> signed or scanned, never neither.

### D4. Every new surface ships off by default

Each phase adds a toggle or rides an existing one, defaulting off. Turning a
surface on for production, adding a secret, or spending money is the user's
decision, recorded in that phase's ADR.

### D5. Phases, each with its own ADR

| Phase | Scope | ADR | Wave |
|---|---|---|---|
| P0 | Channel core: provider registry entries, sender pairing, reply transport, dedup, rate limit, ingress into main chat, settings page, Teams provider fix | 1042 | 1 |
| P5 | SKILL.md import into the signed marketplace | 1044 | 1 |
| P6 | MCP and A2A server hardening, then production enable | 1045 | 1 |
| P1 | Device relay to production grade | 1043 | 2 |
| P2 | Hosted channels: Telegram, Slack replies, WhatsApp two-way, Discord with a gateway worker, Teams bot, Google Chat | extends 0175 / 0394 / 0198, new ADRs as needed | 2–3 |
| P3 | Computer use: hosted remote CDP and the user's own Chrome through the relay | amends 0418 | 3 |
| P4 | Phone calls through Twilio Media Streams, filling `ctx.voice` | new; RFC 0101 check | 3 |
| P7 | Signed desktop app hosting the relay, iOS node and TestFlight | amends 0181 | 4 |

Wave 1 needs no external account. Later waves start when their accounts exist.

## Alternatives considered

- **Official APIs only (the 2026-07-17 decision).** Rejected by the user: it leaves
  out the personal-messenger surfaces the product is meant to cover.
- **Run personal-messenger bridges in the cloud.** Rejected: one Baileys or
  signal-cli session per user in a shared service puts every user's account on
  operator infrastructure and concentrates ban risk on our IPs.
- **Adopt OpenClaw as the gateway.** Rejected: single operator, no tenancy, and
  its sandbox and DM defaults would have to be overridden everywhere.

## Consequences

- The device lane carries account-ban and breakage risk the official lane does
  not. The risk sits with the opting-in user and is shown at setup.
- Discord free-text needs a long-lived gateway worker, a new process shape for
  this deployment (decided in P2).
- Several phases need accounts or spend. They are listed in the roadmap and in
  `docs/steward/TODO.md` § Channels and surfaces, and each waits for the user.

## Decisions recorded

| Date | Decision | By |
|---|---|---|
| 2026-11-03 | Support every surface, the OpenClaw way, in waves | David |
| 2026-11-03 | Reverse MYNDHYVE-DECISIONS 6(e) for the opt-in device lane, on the D2 terms | David |
| 2026-11-03 | Start wave 1 (P0, P5, P6) | David |
| 2026-11-03 | Channel turn scope: "Owner full, others narrow" (ADR 1042 D9) | David |

## Open decisions (the user's)

- Accounts and spend: Telegram bot, Discord app and always-on worker, Slack app,
  Meta WhatsApp Business account or Twilio WhatsApp sender, Azure Bot and Teams
  app, Twilio voice numbers, hosted browser provider, Apple Developer account and
  a Windows code-signing certificate.
- Production enable of the MCP and A2A servers after P6.
- Which default-off toggles go on for MyndHyve tenants.

## Implementation record

| Phase | PR | Merged | Live |
|---|---|---|---|
| P6 (ADR 1045) | #5531 | efbd0819c | 2026-11-03, app.openwop.dev (9a05b6cb8): a live security fix, both servers were already on |
| P6 push follow-up | #5552 | 46301fb8f | 2026-11-03, app.openwop.dev (46301fb8f) |
| P5 (ADR 1044) | #5530 | 94422afb8 | deployed 2026-11-03, `marketplace.skill-import` off |
| P0 (ADR 1042) | #5543 | b595fda72 | deployed with `channel-ingress` off |
| P0-8 settings page (ADR 1042) | #5558 | df995f5bc | deployed 2026-11-04 with `channel-ingress` off |
| P1 server (ADR 1043) | #5567 | a93b7d443 | LIVE 2026-11-04 |
| P1 client (ADR 1043) | openwop-cli #87, #88 | f9d8747, cbfed14 | `@openwop/cli` 2.0.0 published 2026-11-04 |
| P1b per-device peer approval (ADR 1043 D9) | #5573 | 4df908ae4 | LIVE 2026-11-05 (3c1ebe770, both halves) |
| RELAY-LOG-RETENTION-1 (ADR 1043) | #5589 | aaf127ac1 | LIVE 2026-11-05 (train 382; 7-day sweep, user-approved) |
| Env-key principal, TST-FUD-GC-1 (ADR 1045) | #5593 | 6c4e6bc36 | LIVE 2026-11-05 (train 383, rev 01155-9w6) |
