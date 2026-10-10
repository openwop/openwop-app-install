# ADR 0792 — Host event names on the v2 wire: project at egress, match either spelling

Status: Accepted (implemented on branch; merge + deploy pending — see the 2026-10-03 correction)

> **CORRECTED 2026-10-03.** This line said "implemented … the deploy is
> recorded below". Neither half was true: no deploy is recorded below, and
> the branch was never merged. The authoring session (2026-09-30) ended with
> its full gate running and no PR. `openwop-app-5f` adopted the work as
> `feat/adr0792-host-event-names`, rebased onto `origin/main` (149 commits
> ahead) with no conflicts, and gates it with the V2 completion batch
> (`docs/steward/V2-COMPLETION-PLAN.md` W7). **After merge, the three chain
> packs (`crm-ops` 1.3.2, `forms-intake` 1.3.2, `people-hr` 1.5.2) need a
> REGISTRY republish and a production pin advance, in that order, or
> production keeps the old trigger names** (strict registry mode ignores
> vendored bumps). Re-check the production subscription and binding counts
> before relying on the "zero to migrate" measurement below.

Closes `NP-V2-10` (`docs/steward/NODE-PACK-AUDIT.md`). The tracker filed 35 names. MEASURED, the population is about 162 four-segment names, plus 8 three-segment `host.*` names and `crm.segment.entered`, so the filed count was a floor.

## Context

This host's ADR 0208 host events (`emitHostEvent`, `host/hostEventDispatcher.ts`) are named `host.<feature>.<entity>.<verb>`. `spec/v2/core/events.md` §Types allows a vendor event two or three kebab segments, and requires the first segment to be an org registered in `spec/v2/declaration.json`. `host` is not registered; `openwop-app` is. So every one of these names was invalid on a major-2 webhook body, which is a `RunEventDoc` whose `type` must match the vendor branch. That is non-conformance with an existing spec, not a spec change, so no RFC applies.

The names leave the process in four places:
- the webhook delivery headers (`x-openwop-event-type`, `openwop-event-type`);
- the delivery body `type`;
- the synthetic `runId: hostext:<type>`;
- the host-extension bindings API.

Routing uses stored bindings and webhook subscriptions, both matched by the exact name. A writer-only rename (the ADR 0674 and ADR 0682 shape) therefore silently stops delivery to every existing subscriber.

**MEASURED on production before deciding, read-only:** 0 webhook subscriptions of any major and 0 host-event bindings.

## Decision (option C, from the architect review)

- **D1.** The host keeps emitting its **v1 dialect in process**, the same rule ADR 0722 set for run events. A **major-2** webhook subscriber receives the projected, grammar-valid spelling. A **major-1** subscriber is byte-identical to before.
- **D2.** `host/hostEventNames.ts` is the **one owner** of the mapping:

  | in-process | v2 wire |
  |---|---|
  | `host.<a>.<b>.<c>` | `openwop-app.<a>.<b>-<c>` |
  | `host.<a>.<b>` | `openwop-app.<a>.<b>` |
  | `crm.segment.entered` | `openwop-app.crm.segment-entered` |

  A name already under `openwop-app.` (from ADR 0674) passes through. Host names go in **neither** the spec codemap (a spec-generated artifact) **nor** `HOST_VENDOR_ROWS`, which is scoped to run events.
- **D3. Egress.** `enqueueDelivery`, the one serializer for every outbound webhook body, projects three things for major 2: the `type`, the delivery-row `eventType` (the worker writes it into both headers), and the `hostext:<type>` run marker.
- **D4. Matching accepts either spelling, and nothing stored is rewritten.** Webhook subscription matching and binding matching compare the **emitted** name's spellings (`{v1, v2}`) against whatever was registered. So only the forward mapping is needed, and there's no ambiguous inverse. The bindings route accepts a grammar-valid `openwop-app.…` name beside `host.…`.
- **D5.** Chain packs name their trigger in the v2 spelling: `crm-ops`, `people-hr` and `forms-intake`. The trigger's `eventName` never routes (bindings do), so an existing install keeps working. This empties the `NP-V2-10` quarantine in `chain-config-conformance` and the `ADMITTED` list in `check-pack-event-names`.
- **D6 (P3).** `host.webhook.response` is a **run** event (`executor.ts`). A major-2 read of it failed with `500 event_type_unmapped`, which ADR 0687's claim that "no host event reaches the run log" missed. It gets a `HOST_VENDOR_ROWS` row, mapping to `openwop-app.webhook-response`, which is exactly what that table exists for.

## Alternatives rejected

- **A, the canonical new name at emit with legacy subscribers kept on legacy.** It needs a binding migration, changes to 22 emitter modules and 32 test files, and parallel per-subscription spelling logic, all to change names that never leave the process on v1.
- **B, dual-emit.** Every event fires twice for wildcard subscribers and for bindings.
- **D, a big-bang rename including external subscription rows.** It silently breaks subscribers, and it can't be reversed.

## Consequences

- The v2 wire is conformant for every host event. v1 is unchanged until it retires on 2026-12-04, and must not be dropped earlier.
- Internal names stay in the legacy dialect. Flipping them after v1 retires is an optional follow-up. It is internal only, and would need `feature.users.nodes`' `host.users.user.` prefix check to accept both spellings.
- A delivery row stores the event type in its subscriber's own spelling, which is what the worker signs and sends. So an operations view that groups deliveries by type shows the same event under two names when both majors subscribe. That's inherent to per-major projection, and it's noted here rather than normalised in the view.
- Historical `triggerData.eventName` (run payload data) is never rewritten, so replay and `:fork` are unaffected.
- `core.openwop.workflows.people-hr` is pinned in production at 1.5.1. The deploy publishes 1.5.2 and advances that pin, in that order. Otherwise strict mode refuses a pin below the vendored copy.

## Implementation record

| Phase | What | Evidence |
|---|---|---|
| P0 | Production measure: 0 subscriptions, 0 bindings | read-only query through the Cloud SQL proxy |
| P1 | `hostEventNames.ts`; egress projection; either-spelling matching; bindings route | `test/host-event-v2-spelling.test.ts`. Sabotaging each of the 3 seams turns 1 test red. `test/host-event-names.test.ts` covers every emitted name (src/ literals, the CRM/KB tables, the catalog, template families): v2-valid, registered org, injective. A sabotage that drops the verb turns 2 red. |
| P2 | 3 chain packs in the v2 spelling; quarantine and `ADMITTED` emptied | `chain-config-conformance` 26/26, `forms-intake-chain-execution` green, `check-pack-event-names` clean. Versions: crm-ops 1.3.2, people-hr 1.5.2, forms-intake 1.3.2 |
| P3 | `host.webhook.response` → `openwop-app.webhook-response` | same test file, major-2 read via the seed seam |
| Review | An adversarial review found 1 High (stale people-hr pins), 1 Medium (the egress precedence had only a unit witness) and 2 Low (copy), all fixed. It also confirmed the run-event/host-rule precedence defect already fixed in `e7ab44e85`: the codemap now wins at egress and matching. | `host-event-v2-spelling` includes the one-serializer precedence witness (sabotage red); people-hr 12/12 |
