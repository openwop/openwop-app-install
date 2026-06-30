# ADR 0142 — Realtime-voice governance boundary (server-side control channel = governance-eligible)

**Status:** **Accepted** (2026-06-25)
**Date:** 2026-06-25
**Scope:** the realtime-voice feature (ADR 0141). Records *why* the two providers are governed
differently, so the divergence reads as an intended boundary, not drift.
**Composes:** ADR 0141 (realtime voice), ADR 0135 (Capability Firewall), ADR 0024/0108 (BYOK /
key custody). Host-internal — no wire change, no RFC (rides RFC 0106 §E).

## Context

ADR 0141 shipped realtime voice for two providers, and they ended up governed **differently**:

- **OpenAI Realtime (RT-4)** — fully governed. The host mediates the WebRTC SDP, owns the session
  (`call_id`), and runs a **server-side sideband WebSocket** that executes tool calls (through the
  ADR 0135 firewall, keyed on the host-owned id) and persists every transcript. The browser does
  audio only; the BYOK key never leaves the host.
- **Gemini Live (RT-5)** — **lower assurance**. Gemini exposes no sideband, so the session
  terminates in the browser. The host mints a **constrained** ephemeral token that locks the
  model + instructions + tools server-side (a tampered client can't self-grant tools), but tool
  **execution** and **transcripts** are still browser-relayed. Labeled as such in the admin UI.

The open question was the strategic fork: stay **OpenAI-primary** (keep the divergence), or pursue
**unified server-mediated voice** (run *both* providers as server-side agents behind a media
platform) so Gemini reaches parity.

## Decision

Adopt an explicit **governance-eligibility rule** for realtime-voice providers:

> **A realtime-voice provider is governance-eligible only if it exposes a server-side control
> channel (a "sideband") that lets the host execute tool calls, capture transcripts, AND keep the
> provider key on the host — without the host proxying audio. Providers without one are offered as
> explicitly lower-assurance and are not enabled for governance/audit tenants.**

This makes the RT-4 sideband the **house pattern**, not an OpenAI special-case, and it sets a clear
bar for the next provider's integrator. Under it: **OpenAI is governance-eligible; Gemini is the
lower-assurance option** until it ships a sideband-equivalent.

The deciding force is **BYOK key custody** (ADR 0024/0108): "the user's provider key and decrypted
audio never leave our host." The only way to *unify* governance across providers is a managed media
platform (option C below) — the one path that breaks that invariant. We are not trading an invariant
we advertise conformance around for governance on a secondary provider absent a named requirement.

## Consequences

- **Keep RT-4 as-is** — it is the durable, governed path, not interim. Do **not** build a media
  server or adopt a managed media/agent platform.
- **Gemini stays where RT-5 put it** — config-locked, labeled lower-assurance. A hard tenant gate
  (governed tenants can't select Gemini) is a cheap follow-up once an admin-role/governance flag
  exists.
- **Next provider** — gated on the same rule. If it has a sideband, it graduates like OpenAI; if
  not, it's lower-assurance by default. Honest advertisement (`OPENWOP_REQUIRE_BEHAVIOR`) still
  applies — never claim governed voice for a provider that can't honor it.

## Alternatives weighed

- **B. Self-host server-mediation** (host proxies audio, runs the agent) — gives Gemini parity and
  keeps the key on-host, but a long-lived media role fights the stateless Cloud Run model + the
  Cloud SQL (f1-micro) connection budget. Operationally untenable here.
- **C. Managed media/agent platform** (LiveKit/Pipecat/Daily) — uniform governance + built-in
  recording with minimal host infra, **but** the platform must hold the key or terminate the
  decrypted audio → **breaks BYOK key custody** + adds vendor lock-in. Rejected absent a named need.
- **A (chosen). OpenAI-primary as a principle** — zero new dependency, preserves the invariant and
  the operational model, keeps the built work. Accepts that Gemini is lower-assurance by design.

## When to revisit (tripwires)

Re-open this decision only if **any** holds:

1. A **named requirement** for governed, audited voice on Gemini (or another non-sideband provider)
   for a real tenant.
2. **BYOK-on-host becomes negotiable for voice** (e.g., a SOC2'd platform is accepted as an
   extension of the trust boundary) — that single change makes C's uniform governance preferable
   and would retire the sideband.
3. **Google ships a Live sideband-equivalent** — then Gemini graduates under the same rule, no
   platform needed.

Until one is true, **A stands and the realtime-voice work is complete.**
