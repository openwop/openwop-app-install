/**
 * RFC 0173 §C.1 / ADR 0635 — the effect-seam manifest, served at `GET /host/effect-seams`.
 *
 * A v2 host advertising `replay` MUST publish every outbound effect path its node
 * runtime can reach, each row naming the mechanism that suppresses it on a replay
 * fork. `replay.md` §"The effect-seam manifest": a seam OMITTED here is invisible
 * to the suite — its absence is not a witness of anything, only a gap an audit
 * finds later. So the cost of a missing row is silent and the cost of a wrong row
 * is a false statement; both are worse than the work of keeping this exact.
 *
 * WHY THE ROWS ARE PINNED TO CALL SITES AND NOT HAND-MAINTAINED. The rows below
 * are one half of a pair. The other half is `effect-seam-manifest.test.ts`, which
 * enumerates every `assertEffectAllowed(...)` call site in `src/` and fails if any
 * of them is absent from `SEAM_CALL_SITES`. Without that, this file is exactly the
 * artifact #2871 already produced here once: an allowlist that kept claiming
 * protection after 55 chain nodes were retargeted off it, protecting nothing and
 * reading green. A self-declaration whose only guarantee is that someone
 * remembered to update it is not a guarantee.
 *
 * `guardedBy` names the real mechanism, and there are two working together
 * (documented at `host/runEffectContext.ts`):
 *   - ADR 0341's typeId fast path, which SERVES the source run's recorded outcome
 *     so the node never executes on a replay; and
 *   - the ADR 0531 ambient-context backstop (`assertEffectAllowed`), which can
 *     only THROW, and whose firing is a bug report rather than a steady state.
 * Naming only one of them would overstate what a single mechanism covers.
 */

/**
 * The `kind` values `schemas/v2/effect-seam-manifest.schema.json` admits.
 *
 * `smtp` and `other` are additions the corpus made (suite rc.61) in response to
 * this host: the enum had no honest value for `smtpEgress.ts`, and `kind` carried
 * no description, so "the outbound effect path" read as the wire protocol while
 * the five values mixed protocol with transport role. `kind` is the outbound WIRE
 * MECHANISM; `other` exists so the next host with an unlisted mechanism is not
 * forced to choose between a wrong label and an omitted row.
 *
 * REQUIRES the vendored schema at suite >= 2.0.0-rc.61. Emitting `smtp` against
 * an older vendored copy is a document the host's own contract rejects, which is
 * why `effect-seam-manifest.test.ts` validates the served body against the
 * VENDORED schema rather than against this type.
 */
export type SeamKind = 'http' | 'queue' | 'storage' | 'provider-sdk' | 'webhook-fanout' | 'smtp' | 'other';

export interface SeamRow {
  /** Host-named outbound path, `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`. */
  seam: string;
  kind: SeamKind;
  /** RFC 0173 §C.1 — every row MUST be guarded. */
  guarded: true;
  guardedBy: string;
  /** RFC 0140 G6 — a `branch` fork re-fires by design; stated as a permission. */
  branchReFires?: boolean;
  note?: string;
}

/**
 * The suppression mechanism, written once. Every row shares it because every row
 * is guarded by the same pair — a per-row string would drift into describing
 * whichever module the author happened to be looking at.
 */
const GUARDED_BY =
  'executor/sideEffects.ts typeId fast path (ADR 0341, serves the recorded outcome) ' +
  '+ host/runEffectContext.ts assertEffectAllowed backstop (ADR 0531, fail-closed)';

/**
 * Every `assertEffectAllowed` call site in `src/`, mapped to the manifest row it
 * belongs to. The KEY is the call site as the drift test finds it (`file:kind`),
 * so a new guarded effect anywhere in the tree fails that test until it is
 * classified here rather than being silently omitted from the wire.
 */
export const SEAM_CALL_SITES: ReadonlyArray<{ file: string; effectKind: string; seam: string }> = [
  { file: 'src/host/connectionInjection.ts', effectKind: 'network-egress', seam: 'http.safe-fetch' },
  { file: 'src/host/brokeredEgress.ts', effectKind: 'network-egress', seam: 'http.brokered-egress' },
  { file: 'src/routes/compensationSeam.ts', effectKind: 'network-egress', seam: 'http.compensation-forward' },
  { file: 'src/host/webhookEgressGuard.ts', effectKind: 'network-egress', seam: 'webhook.delivery' },
  { file: 'src/host/inMemorySurfaces.ts', effectKind: 'blob-write', seam: 'storage.blob-put' },
  { file: 'src/features/billing/stripeApi.ts', effectKind: 'payment', seam: 'provider.stripe' },
  { file: 'src/features/commerce/ucpBuyer/ucpBuyerService.ts', effectKind: 'payment', seam: 'provider.ucp-merchant' },
  { file: 'src/subruns/subRunDispatcher.ts', effectKind: 'dispatch', seam: 'queue.sub-run-dispatch' },
  { file: 'src/notifications/emitter.ts', effectKind: 'notification', seam: 'queue.notification-emit' },
  { file: 'src/host/smtpEgress.ts', effectKind: 'email', seam: 'smtp.send' },
];

export const SEAM_ROWS: readonly SeamRow[] = [
  { seam: 'http.safe-fetch', kind: 'http', guarded: true, guardedBy: GUARDED_BY, branchReFires: true,
    note: 'ctx.http.safeFetch — the general node-facing egress seam.' },
  { seam: 'http.brokered-egress', kind: 'http', guarded: true, guardedBy: GUARDED_BY, branchReFires: true,
    note: 'brokeredPost/brokeredFetch — provider calls that ride the credential broker.' },
  { seam: 'http.compensation-forward', kind: 'http', guarded: true, guardedBy: GUARDED_BY, branchReFires: true,
    note: 'The compensation seam forward + inverse legs. Compensation is itself an effect and re-enters the guard.' },
  { seam: 'webhook.delivery', kind: 'webhook-fanout', guarded: true, guardedBy: GUARDED_BY, branchReFires: true,
    note: 'The undici egress dispatcher behind webhook delivery. replay.md: delivery of a replay fork’s re-emitted events is suppressed unconditionally at the worker.' },
  { seam: 'storage.blob-put', kind: 'storage', guarded: true, guardedBy: GUARDED_BY, branchReFires: true },
  { seam: 'provider.stripe', kind: 'provider-sdk', guarded: true, guardedBy: GUARDED_BY, branchReFires: true,
    note: 'Both the general Stripe call seam and the off-session payment-intent path.' },
  { seam: 'provider.ucp-merchant', kind: 'provider-sdk', guarded: true, guardedBy: GUARDED_BY, branchReFires: true },
  { seam: 'queue.sub-run-dispatch', kind: 'queue', guarded: true, guardedBy: GUARDED_BY, branchReFires: true },
  { seam: 'queue.notification-emit', kind: 'queue', guarded: true, guardedBy: GUARDED_BY, branchReFires: true },
  // The row that produced the enum change. A direct SMTP connection is not `http`
  // (false about the protocol), not `provider-sdk` (false about the mechanism) and
  // not `queue` (false about both) — and omitting it would have made the seam
  // invisible to the suite by `replay.md`'s own negative-existence rule. Both
  // available moves were dishonest, which is what made it worth asking about
  // rather than choosing.
  { seam: 'smtp.send', kind: 'smtp', guarded: true, guardedBy: GUARDED_BY, branchReFires: true,
    note: 'Direct SMTP egress (host/smtpEgress.ts).' },
];
