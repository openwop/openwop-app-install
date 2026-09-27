/**
 * RFC 0209 (ADR 0749) — `ui.a2ui-surface` at per-kind schema version 2.
 *
 * The acceptor half (branch selection, never the union) and the admission half
 * (cross-field rules, the §C.9 fold guard, the recorded shape, sticky taint),
 * driven through the SAME functions the v2 emit seam and the interrupt resolve
 * choke point call. The HTTP legs are witnessed by the corpus scenario
 * `v2-a2ui-v09-surface` on the major-2 conformance lane.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { acceptEnvelope } from '../src/host/envelopeAcceptor.js';
import {
  admitA2uiSurface,
  crossFieldViolation,
  foldGuardViolation,
  nodeHasUntrustedSurface,
  recordedV2Surfaces,
  A2UI_V09_CATALOG_ID,
} from '../src/host/a2uiSurfaceAdmission.js';
import { setEventLogBackend, getEventLog } from '../src/executor/eventLog.js';
import { openStorage } from '../src/storage/index.js';

type Json = Record<string, unknown>;
const create = (sid: string): Json => ({ version: 'v0.9', createSurface: { surfaceId: sid, catalogId: A2UI_V09_CATALOG_ID } });
const components = (sid: string): Json => ({ version: 'v0.9', updateComponents: { surfaceId: sid, components: [
  { id: 'root', component: 'Column', children: ['h', 'go'] },
  { id: 'h', component: 'Text', text: 'Kickoff', variant: 'h2' },
  { id: 'go_label', component: 'Text', text: 'Go' },
  { id: 'go', component: 'Button', child: 'go_label', action: { event: { name: 'resume' } } },
] } });
const data = (sid: string): Json => ({ version: 'v0.9', updateDataModel: { surfaceId: sid, value: { name: 'x' } } });
const del = (sid: string): Json => ({ version: 'v0.9', deleteSurface: { surfaceId: sid } });
const v2 = (sid: string, messages: Json[]): Json => ({ version: 'v0.9', catalogId: A2UI_V09_CATALOG_ID, surfaceId: sid, messages });
const V1_BODY = { catalogVersion: '0.9.1', surface: { components: [{ component: 'text', text: 'hi' }] } };
let n = 0;
function env(schemaVersion: number, payload: unknown, over: Json = {}): Json {
  n += 1;
  return { type: 'ui.a2ui-surface', schemaVersion, envelopeId: `e-${n}`, correlationId: `c-${n}`, payload, meta: { source: 'ai-generation', ts: '2026-09-24T10:00:00Z' }, ...over };
}

describe('acceptEnvelope — the schema version selects ONE branch (RFC 0209 §A.1)', () => {
  it('a version-2 body is admitted at version 2 and refused at version 1', () => {
    expect(acceptEnvelope(env(2, v2('s', [create('s')]))).status).toBe('accepted');
    expect(acceptEnvelope(env(1, v2('s', [create('s')]))).status).toBe('invalid');
  });
  it('a version-1 body is admitted at version 1 (and 0) and refused at version 2 — never the union', () => {
    expect(acceptEnvelope(env(1, V1_BODY)).status).toBe('accepted');
    expect(acceptEnvelope(env(0, V1_BODY)).status).toBe('accepted');
    expect(acceptEnvelope(env(2, V1_BODY)).status).toBe('invalid');
  });
  it('a version with no branch fails closed', () => {
    expect(acceptEnvelope(env(3, v2('s', [create('s')]))).status).toBe('invalid');
  });
  it('the floor is read BEFORE the payload: above it is unknown_schema_version, not a payload failure', () => {
    const r = acceptEnvelope(env(3, v2('s', [create('s')])), { schemaVersionFloor: { 'ui.a2ui-surface': 2 } });
    expect(r.status === 'invalid' && r.reason.startsWith('unknown_schema_version')).toBe(true);
  });
  it('below the floor under warn validates against the ADVERTISED version', () => {
    const opts = { schemaVersionFloor: { 'ui.a2ui-surface': 2 }, envelopeStrictness: 'warn' as const };
    expect(acceptEnvelope(env(1, v2('s', [create('s')])), opts).status).toBe('accepted');
    expect(acceptEnvelope(env(1, V1_BODY), opts).status).toBe('invalid');
    const strict = acceptEnvelope(env(1, v2('s', [create('s')])), { ...opts, envelopeStrictness: 'strict' });
    expect(strict.status === 'invalid' && strict.reason.startsWith('unknown_schema_version')).toBe(true);
  });
  it('the profile refuses what upstream A2UI would admit (functionCall action, obscured field, Image)', () => {
    const bad = (c: Json) => acceptEnvelope(env(2, v2('s', [{ version: 'v0.9', updateComponents: { surfaceId: 's', components: [c] } }]))).status;
    expect(bad({ id: 'b', component: 'Button', child: 'l', action: { functionCall: { call: 'openUrl', args: { url: 'https://evil.example/' } } } })).toBe('invalid');
    expect(bad({ id: 't', component: 'TextField', label: 'Password', variant: 'obscured' })).toBe('invalid');
    expect(bad({ id: 'i', component: 'Image', url: 'https://evil.example/x.png' })).toBe('invalid');
  });
});

describe('the cross-field rules (RFC 0209 §A.2)', () => {
  it('a message surfaceId differing from the payload is refused', () => {
    const p = v2('s', [create('s'), components('other')]);
    expect(crossFieldViolation(p)).toMatch(/surfaceId/);
  });
  it('a createSurface.catalogId differing from the payload is refused', () => {
    const c = create('s'); (c['createSurface'] as Json)['catalogId'] = 'https://example.test/other.json';
    expect(crossFieldViolation(v2('s', [c]))).toMatch(/catalogId/);
    expect(crossFieldViolation(v2('s', [create('s'), components('s')]))).toBeNull();
  });
});

describe('the fold guard (RFC 0209 §C.9)', () => {
  const rec = (surfaceId: string, messages: Json[], sequence = 1) => ({ sequence, surfaceId, contentTrust: 'trusted' as const, messages });
  it('the first envelope for a surface MUST begin with createSurface', () => {
    expect(foldGuardViolation([], 's', [components('s')])).not.toBeNull();
    expect(foldGuardViolation([], 's', [create('s'), components('s')])).toBeNull();
  });
  it('createSurface for a live surface is refused; after deleteSurface it is admitted again', () => {
    expect(foldGuardViolation([rec('s', [create('s')])], 's', [create('s')])).not.toBeNull();
    expect(foldGuardViolation([rec('s', [create('s')]), rec('s', [del('s')], 2)], 's', [create('s'), data('s')])).toBeNull();
  });
  it('nothing may follow deleteSurface without a new createSurface — across envelopes and within one', () => {
    expect(foldGuardViolation([rec('s', [create('s'), del('s')])], 's', [data('s')])).not.toBeNull();
    expect(foldGuardViolation([rec('s', [create('s')])], 's', [del('s'), data('s')])).not.toBeNull();
  });
  it('surfaces fold independently', () => {
    expect(foldGuardViolation([rec('a', [create('a')])], 'b', [components('b')])).not.toBeNull();
  });
});

describe('admission records the envelope; taint is sticky (RFC 0209 §C.11, §C.12)', () => {
  beforeAll(async () => { setEventLogBackend(await openStorage('memory://')); });

  it('records the admitted envelope with its payload byte-equal, bound to its node, and refuses the invalid fold without a trace', async () => {
    const runId = `run-rec-${Date.now()}`;
    const payload = v2('s1', [create('s1'), components('s1')]);
    const ok = await admitA2uiSurface(runId, env(2, payload, { nodeId: 'gate' }));
    expect(ok.status).toBe('admitted');
    const events = await getEventLog().list(runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.nodeId).toBe('gate');
    expect(JSON.stringify((events[0]!.payload as Json)['payload'])).toBe(JSON.stringify(payload));
    expect(((events[0]!.payload as Json)['meta'] as Json)['contentTrust']).toBe('trusted');

    const again = await admitA2uiSurface(runId, env(2, v2('s1', [create('s1')])));
    expect(again).toMatchObject({ status: 'refused', code: 'envelope_invalid' });
    const above = await admitA2uiSurface(runId, env(3, v2('s9', [create('s9')])));
    expect(above).toMatchObject({ status: 'refused', code: 'unknown_schema_version' });
    const kind = await admitA2uiSurface(runId, { ...env(2, v2('s8', [create('s8')])), type: 'media.image' });
    expect(kind).toMatchObject({ status: 'refused', code: 'unknown_envelope_kind' });
    expect(await getEventLog().list(runId)).toHaveLength(1);
  });

  it('one untrusted update taints a trusted surface and a later trusted one does not launder it', async () => {
    const runId = `run-taint-${Date.now()}`;
    await admitA2uiSurface(runId, env(2, v2('t', [create('t'), components('t')]), { nodeId: 'gate' }));
    expect(await nodeHasUntrustedSurface(runId, 'gate')).toBe(false);
    await admitA2uiSurface(runId, env(2, v2('t', [components('t')]), { nodeId: 'gate', meta: { source: 'ai-generation', ts: '2026-09-24T10:00:00Z', contentTrust: 'untrusted' } }));
    await admitA2uiSurface(runId, env(2, v2('t', [components('t')]), { nodeId: 'gate', meta: { source: 'ai-generation', ts: '2026-09-24T10:00:00Z', contentTrust: 'trusted' } }));
    expect(await nodeHasUntrustedSurface(runId, 'gate')).toBe(true);
    // Another node's approval is not tainted by this surface.
    expect(await nodeHasUntrustedSurface(runId, 'other')).toBe(false);
    expect(recordedV2Surfaces(await getEventLog().list(runId)).map((r) => r.contentTrust)).toEqual(['trusted', 'untrusted', 'trusted']);
  });

  it('an untrusted envelope with no nodeId still taints a surface a bound envelope created', async () => {
    const runId = `run-taint2-${Date.now()}`;
    await admitA2uiSurface(runId, env(2, v2('u', [create('u')]), { nodeId: 'gate' }));
    await admitA2uiSurface(runId, env(2, v2('u', [components('u')]), { meta: { source: 'ai-generation', ts: '2026-09-24T10:00:00Z', contentTrust: 'untrusted' } }));
    expect(await nodeHasUntrustedSurface(runId, 'gate')).toBe(true);
  });

  it('concurrent admissions for one surface cannot both create it', async () => {
    const runId = `run-race-${Date.now()}`;
    const [a, b] = await Promise.all([
      admitA2uiSurface(runId, env(2, v2('r', [create('r')]))),
      admitA2uiSurface(runId, env(2, v2('r', [create('r')]))),
    ]);
    expect([a.status, b.status].sort()).toEqual(['admitted', 'refused']);
  });

  it('a v0.9 body sent under a version-1 stamp (admitted under warn) joins the fold AND the taint', async () => {
    const runId = `run-stamp-${Date.now()}`;
    await admitA2uiSurface(runId, env(2, v2('w', [create('w'), components('w')]), { nodeId: 'gate' }));
    const sneak = await admitA2uiSurface(runId, env(1, v2('w', [components('w')]), { nodeId: 'gate', meta: { source: 'ai-generation', ts: '2026-09-24T10:00:00Z', contentTrust: 'untrusted' } }));
    expect(sneak.status).toBe('admitted');
    expect(await nodeHasUntrustedSurface(runId, 'gate')).toBe(true);
    // …and a second createSurface under the version-1 stamp is still refused by the fold.
    expect(await admitA2uiSurface(runId, env(1, v2('w', [create('w')])))).toMatchObject({ status: 'refused', code: 'envelope_invalid' });
  });

  it('a re-emission with a recorded correlationId returns the recorded outcome and appends nothing', async () => {
    const runId = `run-dedup-${Date.now()}`;
    const e = env(2, v2('d', [create('d')]));
    const first = await admitA2uiSurface(runId, e);
    const again = await admitA2uiSurface(runId, e);
    expect(again).toEqual(first);
    expect(await getEventLog().list(runId)).toHaveLength(1);
  });
});

describe('the envelope catalog edges', () => {
  it('an absent schemaVersion is 0 — below a floor of 2, refused under strict', () => {
    const e = env(2, v2('s', [create('s')])); delete e['schemaVersion'];
    const r = acceptEnvelope(e, { schemaVersionFloor: { 'ui.a2ui-surface': 2 }, envelopeStrictness: 'strict' });
    expect(r.status === 'invalid' && r.reason.startsWith('unknown_schema_version')).toBe(true);
  });
  it('the v2 catalog advert is absent where nothing admits the kind', async () => {
    const { a2uiV2AdmissionReachable } = await import('../src/host/a2uiSurfaceAdmission.js');
    const prior = process.env.OPENWOP_TEST_SEAM_ENABLED;
    try {
      delete process.env.OPENWOP_TEST_SEAM_ENABLED;
      expect(a2uiV2AdmissionReachable()).toBe(false);
      process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
      expect(a2uiV2AdmissionReachable()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.OPENWOP_TEST_SEAM_ENABLED; else process.env.OPENWOP_TEST_SEAM_ENABLED = prior;
    }
  });
});
