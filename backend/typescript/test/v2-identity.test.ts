/**
 * v2 charter Phase 4 (P4-D) — the v2 identity surfaces, unit-level.
 *
 * These lock the DECISIONS, not just the behaviour: that the tenant-bound run
 * id is a reversible wire projection over an unchanged store, that the two v2
 * lanes are read back from the issuer rather than re-minted, that the resume
 * token is one grammar with one refusal code, and that the closed v2 snapshot
 * is filtered from the artifact rather than from a retyped list. The
 * end-to-end HTTP legs are the conformance scenarios
 * (`v2-owner-subject-required`, `v2-id-grammar`, `v2-idempotency-key-grammar`,
 * `v2-interrupt-token-scheme`).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** The same file `closeV2Snapshot` derives its closed set from — the test and the
 *  implementation MUST read one artifact, or the test pins a copy that drifts. */
const V2_SNAPSHOT_SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2', 'run-snapshot.schema.json');
import {
  V2_IDEMPOTENCY_KEY,
  V2_OPAQUE_ID,
  V2_TENANT_BOUND_ID,
  fromWireRunId,
  projectV2RunIds,
  toWireRunId,
} from '../src/host/v2Ids.js';
import { runOwnerV2, projectV2OwnerEcho, ANON_SUBJECT_ISSUER, SESSION_SUBJECT_ISSUER, LEGACY_SUBJECT_ISSUER, anonOwnerStamp } from '../src/host/runOwner.js';
import { closeV2Snapshot } from '../src/host/v2Snapshot.js';
import { mintInterruptToken, verifyInterruptToken } from '../src/host/interruptToken.js';

const UUID = '8a8bdcd3-5214-4b8b-8ccb-6ed1938b04ab';

describe('identity.md §5 — the tenant-bound run id is a reversible wire projection', () => {
  it('a bare uuid projects to <tenant>/<opaque> and matches the runId grammar', () => {
    const wire = toWireRunId(UUID, 'default');
    expect(wire).toBe(`default/${UUID}`);
    expect(V2_TENANT_BOUND_ID.test(wire)).toBe(true);
    expect(V2_OPAQUE_ID.test(UUID)).toBe(true);
  });

  it('round-trips: the id the caller is handed is the id the store is asked for', () => {
    const back = fromWireRunId(toWireRunId(UUID, 'default'), 'default');
    expect(back).toEqual({ ok: true, runId: UUID });
  });

  it('a tenant segment that is not the caller’s is reported, never silently accepted', () => {
    expect(fromWireRunId(`someone-else/${UUID}`, 'default')).toEqual({ ok: false, segment: 'someone-else' });
  });

  it('a bare id presented on the v2 wire is accepted verbatim (this host’s own clients address runs that way)', () => {
    expect(fromWireRunId(UUID, 'default')).toEqual({ ok: true, runId: UUID });
  });

  it('an id the v2 grammar cannot express is left alone rather than encoded into something irreversible', () => {
    // Host-internal pseudo-run ids (`hostext:sync:<uuid>`) carry a `:`, which
    // the host-minted opaque grammar excludes. They are not reachable on the v2
    // path space; inventing an encoding would break the round-trip above.
    expect(toWireRunId(`hostext:sync:${UUID}`, 'default')).toBe(`hostext:sync:${UUID}`);
    expect(toWireRunId(UUID, 'anon:abcdef')).toBe(UUID);
    expect(toWireRunId(`default/${UUID}`, 'default')).toBe(`default/${UUID}`);
  });

  it('projects runId keys anywhere in a body, and the create response URLs onto the v2 path key', () => {
    const body = projectV2RunIds(
      {
        runId: UUID,
        parentRunId: UUID,
        eventsUrl: `http://h/v1/runs/${UUID}/events`,
        statusUrl: `http://h/v1/runs/${UUID}`,
        events: [{ runId: UUID, type: 'run.started' }],
        variables: { note: UUID },
      },
      'default',
    ) as Record<string, unknown>;
    expect(body['runId']).toBe(`default/${UUID}`);
    expect(body['parentRunId']).toBe(`default/${UUID}`);
    // RFC 0184 §A.1 / ADR 0705 — these two asserted `%2F` until 2026-09-16, and
    // that was correct until the corpus changed which spelling a host MUST EMIT.
    // Kept as LITERALS rather than `projectBoundId(...)`: this is the unit-level
    // oracle for the emitted spelling, and an expectation computed by the code
    // under test would assert nothing. `-` is passthrough in the projection, so
    // only the separator moves.
    expect(body['eventsUrl']).toBe(`http://h/runs/default~2F${UUID}/events`);
    expect(body['statusUrl']).toBe(`http://h/runs/default~2F${UUID}`);
    expect((body['events'] as Array<{ runId: string }>)[0]!.runId).toBe(`default/${UUID}`);
    // Keys, not values: a run id sitting in a caller-supplied bag under some
    // other key is not a `runId` field and MUST NOT be rewritten.
    expect((body['variables'] as { note: string }).note).toBe(UUID);
  });
});

describe('identity.md §1.1 — the closed v2 owner block', () => {
  const stamp = (subject: Record<string, unknown>, principal = 'b53f77090629a5a2') => ({
    tenantId: 'default',
    metadata: { owner: { principal, subject } },
  });

  it('drops principal / principalKind and keeps { tenant, subject }', () => {
    const owner = runOwnerV2(stamp({ issuer: 'urn:openwop-app:env-key', subjectId: 'b53f77090629a5a2', lane: 'api-key', kind: 'workload' }));
    expect(Object.keys(owner).sort()).toEqual(['subject', 'tenant']);
    expect(owner.subject.tenant).toBe('default');
    expect(owner.subject.lane).toBe('api-key');
  });

  it('§A.2 — a session subject reads back on the `session` lane, from the issuer it was attested under', () => {
    const owner = runOwnerV2(stamp({ issuer: SESSION_SUBJECT_ISSUER, subjectId: 'b53f77090629a5a2', lane: 'api-key', kind: 'user' }));
    expect(owner.subject.lane).toBe('session');
    expect(owner.subject.kind).toBe('user');
  });

  it('§A.2 — an anonymous subject reads back on the `anonymous` lane, and kind ⇔ lane holds', () => {
    const owner = runOwnerV2({ tenantId: 'default', metadata: { owner: anonOwnerStamp('anon0123456789ab') } });
    expect(owner.subject.lane).toBe('anonymous');
    expect(owner.subject.kind).toBe('anonymous');
  });

  it('§A.2 — `keyClass` survives only on saml / scim', () => {
    const saml = runOwnerV2(stamp({ issuer: 'urn:idp', subjectId: 'b53f77090629a5a2', lane: 'saml', kind: 'user', keyClass: 'opaque-idp' }));
    expect(saml.subject.keyClass).toBe('opaque-idp');
    const key = runOwnerV2(stamp({ issuer: 'urn:openwop-app:api-key', subjectId: 'b53f77090629a5a2', lane: 'api-key', kind: 'workload', keyClass: 'opaque-idp' }));
    expect(key.subject.keyClass).toBeUndefined();
  });

  it('§1.2 — a run this host recorded no principal for reads with the legacy subject, never an absent owner', () => {
    const owner = runOwnerV2({ tenantId: 'default', metadata: {} });
    expect(owner.subject.issuer).toBe(LEGACY_SUBJECT_ISSUER);
    expect(owner.subject.subjectId).toBe('legacy');
    expect(owner.subject.lane).toBe('api-key');
    expect(owner.subject.kind).toBe('user');
    expect(owner.tenant).toBe('default');
  });

  it('§A.1 — the `run.started` echo is projected by the SAME rule as the snapshot', () => {
    const payload = projectV2OwnerEcho({
      workflowId: 'w',
      owner: { tenant: 'default', principal: 'b53f77090629a5a2', subject: { issuer: ANON_SUBJECT_ISSUER, subjectId: 'anon0123456789ab', lane: 'api-key', kind: 'anonymous', tenant: 'default' } },
    }) as { owner: { tenant: string; subject: { lane: string; kind: string } }; workflowId: string };
    expect(payload.workflowId).toBe('w');
    expect(Object.keys(payload.owner).sort()).toEqual(['subject', 'tenant']);
    expect(payload.owner.subject.lane).toBe('anonymous');
    expect(payload.owner.subject.kind).toBe('anonymous');
  });

  it('a payload with no owner is returned untouched', () => {
    const p = { nodeId: 'n' };
    expect(projectV2OwnerEcho(p)).toBe(p);
  });
});

describe('runs.md §Snapshot — the object is closed', () => {
  it('drops every host-extension field v2 declares no seat for', () => {
    const input = {
      runId: 'default/x',
      workflowId: 'w',
      status: 'completed',
      owner: { tenant: 'default' },
      eventLogSchemaVersion: 3,
      variables: {},
      // host extensions + v1-only fields
      parentRunId: 'p',
      parentSeq: 1,
      forkMode: 'branch',
      parentNodeId: 'n',
      inputs: {},
      removalAt: 'x',
      pinned: true,
      costUsd: 1,
      costByNode: {},
      childRuns: [],
      interrupt: {},
    };
    const closed = closeV2Snapshot(input);
    // THE INVARIANT, NOT A SNAPSHOT OF THE SCHEMA. This used to pin a six-key
    // list and went red the moment the corpus gave `parentRunId` and `inputs`
    // a v2 seat (rc.29) — the implementation was right and the test was
    // asserting what the schema said on the day it was written. So: every key
    // the vendored `run-snapshot.schema.json` declares is KEPT, every key it
    // does not is DROPPED, derived from the same file the implementation reads.
    const declared = new Set(Object.keys(
      (JSON.parse(readFileSync(V2_SNAPSHOT_SCHEMA, 'utf8')) as { properties: Record<string, unknown> }).properties,
    ));
    const given = Object.keys(input);
    expect(Object.keys(closed).sort()).toEqual(given.filter((k) => declared.has(k)).sort());
    // Non-vacuity: a closure that drops nothing and one that keeps nothing both
    // satisfy a filter identity trivially. Both directions must be exercised.
    expect(given.some((k) => !declared.has(k)), 'the fixture must carry a field v2 has no seat for').toBe(true);
    expect(Object.keys(closed).length, 'the closed object must keep something').toBeGreaterThan(0);
    expect(Object.keys(closed).length).toBeLessThan(given.length);
  });
});

describe('identity.md §4 — the resume token scheme', () => {
  it('mints ow2.<alg>.<kid>.<payload>.<mac> and verifies it', () => {
    const token = mintInterruptToken();
    const parts = token.split('.');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('ow2');
    expect(parts[1]).toBe('hs256');
    expect(verifyInterruptToken(token)).toMatchObject({ form: 'ow2' });
  });

  it('an unadvertised alg, an unheld kid, a bad MAC and a malformed token are all one code', () => {
    const token = mintInterruptToken();
    const [, , kid, payload, mac] = token.split('.') as [string, string, string, string, string];
    expect(verifyInterruptToken(`ow2.hs512.${kid}.${payload}.${mac}`).form).toBe('invalid');
    expect(verifyInterruptToken(`ow2.hs256.nokid.${payload}.${mac}`).form).toBe('invalid');
    expect(verifyInterruptToken(`ow2.hs256.${kid}.${payload}.${mac}X`).form).toBe('invalid');
    expect(verifyInterruptToken('ow2.hs256.short').form).toBe('invalid');
  });

  it('a token without the prefix is this host’s drained v1 credential, not a refusal', () => {
    // `persistence.md` — outstanding v1 tokens resolve under `kid: legacy`
    // until `expiresAt`; the store lookup is what decides them.
    expect(verifyInterruptToken('b3BlbndvcC1jb25mb3JtYW5jZQ.0123456789abcdef').form).toBe('legacy');
    expect(verifyInterruptToken('KHTMmwvKQGiJmNaUqp2Vi_i6xKBd3yPFHhQeZ_HRuOs').form).toBe('legacy');
  });
});

describe('idempotency.md §Layer 1 — the key grammar', () => {
  it('accepts 128 bits of base64url and a canonical UUIDv4; refuses a short key', () => {
    expect(V2_IDEMPOTENCY_KEY.test('AAAAAAAAAAAAAAAAAAAAAA')).toBe(true); // 22 chars
    expect(V2_IDEMPOTENCY_KEY.test(UUID)).toBe(true); // 36 chars
    expect(V2_IDEMPOTENCY_KEY.test('short')).toBe(false);
    expect(V2_IDEMPOTENCY_KEY.test('has spaces and is long enough')).toBe(false);
    expect(V2_IDEMPOTENCY_KEY.test(`internal/${UUID}`)).toBe(false);
  });
});
