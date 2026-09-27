# ADR 0285 — Connection-lifecycle seam: disable dependents on revoke

Status: implemented

## Context

`docs/steward/DATA-ASSESSMENT.md` RI-6 (= `docs/research/data-gaps.md` DG-INT-4): `revokeConnection`
deleted the secret + the connection row and nothing else. Configs riding the credential
survived pointing at a dead connection: the inbound-webhook binding
(`connections/inboundWebhooks.ts` — keyed BY connectionId), knowledge-sync sources
(`SyncSource.connectionId`), and CRM gmail syncs (`GmailSync.connectionId`) — daemons and
schedulers kept retrying a credential that could never resolve again.

Use-time was already fail-closed (a missing secret fails the operation), so the risk was
never a security hole — it was orphan accumulation, wasted daemon work, and invisibility:
the user had no signal about what their revoke broke.

## Decision

**Disable, never delete** (architect ruling): dependent configs are user-authored work —
marking them paused/disabled shows the user exactly what broke, and re-connecting is a
*resume*, not a rebuild.

Mechanism: `host/connectionLifecycle.ts` — the third instance of the keyed-registry
lifecycle pattern (`commerce/productLifecycleSeam.ts` #1337, `host/crmRecordLifecycle.ts`
ADR 0283), same contract verbatim: keyed registration (repeated boots overwrite, never
stack), handlers idempotent + bounded, best-effort fan-out that never throws or blocks the
revoke, fired AFTER the secret + row are deleted (fail-closed ordering: a mid-way handler
failure leaves re-markable rows, never a resurrected credential).

Consumers shipped with the seam (witnessed, not speculative):

| Consumer (key) | Effect on revoke |
|---|---|
| `connections-inbound` | inbound config `enabled: false` + trigger-bridge subscription paused (config + inbound signing secret survive — the signing secret is inbound-specific, not the revoked credential) |
| `knowledge-sync` | sources on the connection → `status: 'paused'` with `lastError: 'Connection revoked — reconnect to resume syncing.'` (the daemon only runs `active` sources) |
| `crm-gmail-sync` | gmail syncs on the connection → `status: 'paused'` via `updateGmailSync`, which also disables the scheduler job |

Deliberately NOT consumers: **messaging bindings** (the relay is a demo, non-normative
surface; its sessions already fail closed per-message) and **read-time references**
(destination-sync/kb hold connectionIds they resolve at use — fail-closed already, nothing
durable to disable). Both recorded here so their absence is a decision, not an oversight.

## Alternatives weighed

1. **Delete dependent configs on revoke** — rejected: destroys authored work and hides
   the blast radius from the user; a re-connect would require rebuilding bindings.
2. **Leave everything (status quo) + document tolerate-on-read** — rejected: daemons keep
   burning retries on dead credentials and the user gets no signal.
3. **Direct calls from `revokeConnection` into each consumer** — rejected: N feature
   imports inside connections, the dependency inversion the seam pattern exists to avoid.

## Phase → artifact

| Phase | Artifact |
|---|---|
| Seam + fire | `host/connectionLifecycle.ts`, `connections/connectionsService.ts` |
| Consumers | `connections/inboundWebhooks.ts` (+`feature.ts`), `knowledge-sync/knowledgeSyncService.ts` (+`feature.ts`), `crm/gmailSyncService.ts` (+`feature.ts`) |
| e2e tests | `test/connection-lifecycle.test.ts` |
