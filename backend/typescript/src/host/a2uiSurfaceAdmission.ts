/**
 * `ui.a2ui-surface` admission at major 2 — RFC 0209 (ADR 0749).
 *
 * The ONE path a `ui.a2ui-surface` envelope takes into a run's event log under
 * the v2 contract. `spec/v2/ext/a2uiSurface/README.md` + `core/events.md`
 * §"The envelope-kind catalog" fix the order, and this module is that order:
 *
 *   1. the envelope-kind catalog — `supportedEnvelopes.kinds`, then the
 *      `schemaVersions.kinds` floor, then `envelopeStrictness` — composed in
 *      `acceptEnvelope` (the host's single envelope validator), which also
 *      validates the payload against the ONE branch the version selects;
 *   2. the RFC 0209 §A.2 cross-field rules the schema cannot express;
 *   3. the §C.9 fold guard;
 *   4. append a real run event recording the admitted envelope.
 *
 * The catalog values are the SAME constants the v2 discovery advert prints
 * (`V2_A2UI_ENVELOPE_CATALOG`), so the advert and the admission cannot disagree.
 *
 * THE FOLD IS DERIVED, NOT STORED. A surface's state is the fold of the run's
 * recorded version-2 envelopes for its `surfaceId`, read back from the event log.
 * There is no side table, so a `:fork` — which copies the `[0, fromSeq)` prefix
 * — folds exactly the prefix, and nothing needs migrating (§C.11).
 *
 * CONCURRENCY. read-fold → append is serialised per run IN PROCESS. Today the
 * only emitter is the env-gated conformance seam; a production emitter on a
 * multi-instance deployment would need the store to arbitrate instead (ADR 0749
 * §Residuals).
 */
import { acceptEnvelope, type AcceptOptions, type ValidationDetail } from './envelopeAcceptor.js';
import { getEventLog } from '../executor/eventLog.js';
import { OpenwopError, type EventRecord } from '../types.js';

export const A2UI_SURFACE_KIND = 'ui.a2ui-surface';
export const A2UI_V09_CATALOG_ID = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

/**
 * The major-2 envelope-kind catalog this host serves — the advert
 * (`routes/discovery.ts`) and the admission below both read it. Only
 * `ui.a2ui-surface` is listed because it is the only non-universal kind with a
 * major-2 admission path; `media.*` stays a v1 claim (ADR 0749 D7).
 */
export const V2_A2UI_ENVELOPE_CATALOG = {
  kinds: [A2UI_SURFACE_KIND] as readonly string[],
  schemaVersions: { [A2UI_SURFACE_KIND]: 2 } as Readonly<Record<string, number>>,
  strictness: 'warn' as const,
};

/**
 * Is a major-2 admission path for `ui.a2ui-surface` reachable on this
 * deployment? Today the only caller of `admitA2uiSurface` is the env-gated
 * `emitA2uiSurface` seam, so on a deployment without it NOTHING admits the kind
 * at major 2 — and the v2 catalog advert must then stay absent (absent means
 * "refuse every non-universal kind", which is exactly what such a host does).
 * When a production node emits v0.9 surfaces through `admitA2uiSurface`, this
 * becomes `true` unconditionally.
 */
export function a2uiV2AdmissionReachable(): boolean {
  return process.env.OPENWOP_TEST_SEAM_ENABLED === 'true';
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The one body key of an A2UI message (`createSurface`, `updateComponents`, …). */
function messageKind(m: unknown): { kind: string; body: Json } | null {
  if (!isRecord(m)) return null;
  for (const [k, v] of Object.entries(m)) {
    if (k !== 'version' && isRecord(v)) return { kind: k, body: v };
  }
  return null;
}

/** A recorded version-2 surface envelope, as `admitA2uiSurface` writes it. */
export interface RecordedSurfaceEnvelope {
  readonly sequence: number;
  readonly nodeId?: string;
  readonly surfaceId: string;
  readonly contentTrust: 'trusted' | 'untrusted';
  readonly messages: readonly unknown[];
}

/** The v0.9 surface envelopes a run recorded, in `sequence` order. A 0.9.1
 *  surface (flat `{catalogVersion, surface}` payload) is not part of any fold
 *  and is skipped. */
export function recordedV2Surfaces(events: readonly EventRecord[]): RecordedSurfaceEnvelope[] {
  const out: RecordedSurfaceEnvelope[] = [];
  for (const ev of events) {
    if (ev.type !== A2UI_SURFACE_KIND) continue;
    const env = ev.payload;
    if (!isRecord(env) || !isRecord(env['payload'])) continue;
    const p = env['payload'];
    // Classified by the BODY that was validated, never by the envelope's own
    // `schemaVersion`: under `warn` a version-1 envelope carrying a v0.9 body is
    // validated against version 2 and recorded, and it MUST join the fold (and
    // the taint) like any other — keying on the stamp let it slip past both.
    if (p['version'] !== 'v0.9' || typeof p['surfaceId'] !== 'string' || !Array.isArray(p['messages'])) continue;
    const meta = isRecord(env['meta']) ? env['meta'] : {};
    out.push({
      sequence: ev.sequence,
      ...(typeof ev.nodeId === 'string' ? { nodeId: ev.nodeId } : {}),
      surfaceId: p['surfaceId'],
      contentTrust: meta['contentTrust'] === 'untrusted' ? 'untrusted' : 'trusted',
      messages: p['messages'] as unknown[],
    });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

/**
 * The run's log in the HOST's own vocabulary (`contract: 1`), whatever major
 * the current request speaks. A major-2 read would translate every event and —
 * for an era-2 log holding a `ui.a2ui-surface` row (org `ui` is unregistered) —
 * fail with `event_type_unmapped`, making the approval unresolvable over v2.
 */
function readRunLog(runId: string): Promise<readonly EventRecord[]> {
  return getEventLog().list(runId, { contract: 1 });
}

/** Is `surfaceId` live after folding `recorded` (created, not since deleted)? */
function surfaceLive(recorded: readonly RecordedSurfaceEnvelope[], surfaceId: string): boolean {
  let live = false;
  for (const r of recorded) {
    if (r.surfaceId !== surfaceId) continue;
    for (const m of r.messages) {
      const k = messageKind(m)?.kind;
      if (k === 'createSurface') live = true;
      else if (k === 'deleteSurface') live = false;
    }
  }
  return live;
}

/**
 * RFC 0209 §C.9 — would appending `messages` to the fold keep it valid? Returns
 * the violated rule, or `null`. Pure; the caller supplies the recorded prefix.
 */
export function foldGuardViolation(recorded: readonly RecordedSurfaceEnvelope[], surfaceId: string, messages: readonly unknown[]): string | null {
  let live = surfaceLive(recorded, surfaceId);
  for (const [i, m] of messages.entries()) {
    const k = messageKind(m)?.kind;
    if (k === 'createSurface') {
      if (live) return `messages[${i}]: createSurface for surface '${surfaceId}', which is already live`;
      live = true;
    } else if (!live) {
      return `messages[${i}]: ${k ?? 'message'} for surface '${surfaceId}', which has no live createSurface (the first envelope for a surface MUST begin with createSurface, and nothing may follow deleteSurface without a new one)`;
    } else if (k === 'deleteSurface') {
      live = false;
    }
  }
  return null;
}

/** RFC 0209 §A.2 — the two cross-field rules the schema cannot express. */
export function crossFieldViolation(payload: Json): string | null {
  const surfaceId = payload['surfaceId'];
  const catalogId = payload['catalogId'];
  const messages = Array.isArray(payload['messages']) ? payload['messages'] : [];
  for (const [i, m] of messages.entries()) {
    const mk = messageKind(m);
    if (!mk) continue;
    if (mk.body['surfaceId'] !== surfaceId) return `messages[${i}].${mk.kind}.surfaceId MUST equal the payload surfaceId`;
    if (mk.kind === 'createSurface' && mk.body['catalogId'] !== catalogId) return `messages[${i}].createSurface.catalogId MUST equal the payload catalogId`;
  }
  return null;
}

/**
 * RFC 0209 §C.12 — sticky taint. Is any surface bound to `nodeId` in this run
 * untrusted? One untrusted envelope taints the whole surface for the rest of
 * its history, and a later trusted one never launders it. Deliberately counts a
 * deleted surface too: the bound interrupt is still the one its actions would
 * have resolved, and failing closed costs nothing here.
 */
export async function nodeHasUntrustedSurface(runId: string, nodeId: string): Promise<boolean> {
  const recorded = recordedV2Surfaces(await readRunLog(runId));
  const bound = new Set(recorded.filter((r) => r.nodeId === nodeId).map((r) => r.surfaceId));
  return recorded.some((r) => bound.has(r.surfaceId) && r.contentTrust === 'untrusted');
}

/**
 * RFC 0209 §C.12 — refuse to resolve an `approval` bound to a tainted surface.
 * Called by `resolveAndResume` AND by any path that CONSUMES an interrupt
 * before resuming it (the MCP `requestState` claim), which must check first or
 * it strands the interrupt: consumed, never resumed.
 */
export async function assertApprovalSurfaceTrusted(interrupt: { readonly kind: string; readonly runId: string; readonly nodeId: string }): Promise<void> {
  if (interrupt.kind !== 'approval') return;
  // ADR 0755 (WIT-A2UI-4) — every approval resolve used to read the run's WHOLE
  // log for surfaces only `admitA2uiSurface` records, and that has exactly one
  // caller: the env-gated seam `a2uiV2AdmissionReachable` tracks. Where nothing
  // can record a v0.9 surface there is nothing to be tainted by, so the read is
  // skipped. The two move together: a production emitter flips that predicate
  // to `true` unconditionally (its own docblock), which re-arms this check.
  if (!a2uiV2AdmissionReachable()) return;
  if (!(await nodeHasUntrustedSurface(interrupt.runId, interrupt.nodeId))) return;
  throw new OpenwopError(
    'untrusted_content_blocks_approval',
    'this approval is bound to an A2UI surface that untrusted content touched; it cannot be resolved (RFC 0209 §C.12)',
    403,
    { reason: 'untrusted_content_blocks_approval', nodeId: interrupt.nodeId },
  );
}

export type A2uiAdmission =
  | { status: 'admitted'; sequence: number; eventId: string }
  | { status: 'refused'; code: 'unknown_envelope_kind' | 'unknown_schema_version' | 'envelope_invalid'; reason: string; details?: readonly ValidationDetail[] };

// Per-run serialisation of read-fold → append (see header).
const runChains = new Map<string, Promise<unknown>>();
function serialisePerRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
  const prior = runChains.get(runId) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(work);
  const tail = next.catch(() => undefined);
  runChains.set(runId, tail);
  void tail.then(() => { if (runChains.get(runId) === tail) runChains.delete(runId); });
  return next;
}

/**
 * Admit one `ui.a2ui-surface` envelope into `runId` under the major-2 catalog,
 * and record it. `opts` carries only what the caller legitimately knows beyond
 * the catalog (the run's trust boundary, SR-1 canaries).
 */
export function admitA2uiSurface(
  runId: string,
  envelope: unknown,
  opts: Pick<AcceptOptions, 'runTrustBoundary' | 'byokCanaries'> = {},
): Promise<A2uiAdmission> {
  return serialisePerRun(runId, async () => {
    const env = isRecord(envelope) ? envelope : {};
    const outcome = acceptEnvelope(envelope, {
      ...opts,
      hostSupportedEnvelopes: V2_A2UI_ENVELOPE_CATALOG.kinds,
      schemaVersionFloor: V2_A2UI_ENVELOPE_CATALOG.schemaVersions,
      envelopeStrictness: V2_A2UI_ENVELOPE_CATALOG.strictness,
    });
    if (outcome.status === 'gated') return { status: 'refused', code: 'unknown_envelope_kind', reason: outcome.reason };
    if (outcome.status === 'breached') return { status: 'refused', code: 'envelope_invalid', reason: outcome.reason };
    if (outcome.status === 'invalid') {
      const code = outcome.reason.startsWith('unknown_schema_version') ? 'unknown_schema_version' : 'envelope_invalid';
      return { status: 'refused', code, reason: outcome.reason, details: outcome.details };
    }
    // `acceptEnvelope` admits every advertised kind; this path records only ours.
    if (env['type'] !== A2UI_SURFACE_KIND) return { status: 'refused', code: 'unknown_envelope_kind', reason: `this admission path records ${A2UI_SURFACE_KIND} only` };

    const log = await readRunLog(runId);
    // events.md E2 / RFC 0021 §"Replay determinism" — a re-emission with a
    // recorded `correlationId` returns the recorded outcome; it is neither
    // re-appended nor re-judged against a fold it already changed.
    const correlationId = env['correlationId'];
    const prior = log.find((ev) => ev.type === A2UI_SURFACE_KIND && isRecord(ev.payload) && ev.payload['correlationId'] === correlationId);
    if (prior) return { status: 'admitted', sequence: prior.sequence, eventId: prior.eventId };

    const payload = (outcome.redactedPayload ?? env['payload']) as Json;
    // A version-2 body (the branch validator has already proven its shape) is
    // subject to the cross-field rules and the fold; a version-1 body is not
    // part of any fold (it can only reach here under a floor of 1).
    const isV2Body = payload['version'] === 'v0.9';
    if (isV2Body) {
      const cross = crossFieldViolation(payload);
      if (cross) return { status: 'refused', code: 'envelope_invalid', reason: `RFC 0209 §A.2: ${cross}` };
      const recorded = recordedV2Surfaces(log);
      const fold = foldGuardViolation(recorded, payload['surfaceId'] as string, payload['messages'] as unknown[]);
      if (fold) return { status: 'refused', code: 'envelope_invalid', reason: `RFC 0209 §C.9: ${fold}` };
    }

    const nodeId = typeof env['nodeId'] === 'string' ? env['nodeId'] : undefined;
    const recordedEnvelope: Json = {
      ...env,
      payload,
      meta: { ...(isRecord(env['meta']) ? env['meta'] : {}), contentTrust: outcome.normalizedMeta.contentTrust },
    };
    const rec = await getEventLog().append({
      runId,
      type: A2UI_SURFACE_KIND,
      ...(nodeId ? { nodeId } : {}),
      payload: recordedEnvelope,
    });
    return { status: 'admitted', sequence: rec.sequence, eventId: rec.eventId };
  });
}
