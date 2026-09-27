import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { locateRepoSchemasDir } from '../src/host/_repoPath.js';
import { applyPayloadKeyAliases, payloadKeyAliases, projectV2Payload } from '../src/storage/v2PayloadProjection.js';
import { demoAutoIngestSubscriptionId } from '../src/host/triggerBridgeService.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = locateRepoSchemasDir(here, 'run-event.schema.json');
const payloads = JSON.parse(readFileSync(join(schemasDir, 'v2', 'run-event-payloads.schema.json'), 'utf8')) as {
  $defs: Record<string, { properties?: Record<string, unknown>; $ref?: string }> & { _typeIndex: { properties: Record<string, { $ref: string }> } };
};
const defFor = (type: string) => {
  const ref = payloads.$defs._typeIndex.properties[type]?.$ref ?? '';
  let d = payloads.$defs[ref.replace(/^#\/\$defs\//, '')];
  while (d?.$ref) d = payloads.$defs[d.$ref.replace(/^#\/\$defs\//, '')];
  return d;
};

/** Ajv over the vendored corpus, siblings registered by walking `$ref`s (ADR 0702). */
function validatorFor(defName: string) {
  const req = createRequire(join(here, '..', 'package.json'));
  const Ajv = (req('ajv/dist/2020.js').default ?? req('ajv/dist/2020.js')) as new (o: object) => { addSchema: (s: unknown, k: string) => void; getSchema: (k: string) => ((d: unknown) => boolean) | undefined };
  const ajv = new Ajv({ strict: false, allErrors: true });
  (req('ajv-formats').default ?? req('ajv-formats'))(ajv);
  const registered = new Set(['run-event-payloads.schema.json']);
  ajv.addSchema(payloads, 'run-event-payloads.schema.json');
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n === null || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') {
        const file = v.split('#')[0]?.split('/').pop() ?? '';
        if (file.endsWith('.schema.json') && !registered.has(file)) {
          registered.add(file);
          const doc = JSON.parse(readFileSync(join(schemasDir, 'v2', file), 'utf8')) as { $id?: string };
          ajv.addSchema(doc, file);
          if (typeof doc.$id === 'string') { try { ajv.addSchema(doc, doc.$id); } catch { /* dup */ } }
          walk(doc);
        }
      } else walk(v);
    }
  };
  walk(payloads);
  const v = ajv.getSchema(`run-event-payloads.schema.json#/$defs/${defName}`);
  if (!v) throw new Error(`def ${defName} did not compile`);
  return v;
}

describe('ADR 0722 — payload key aliases are migration debt with a tripwire', () => {
  it('every alias TARGET is a declared property of the def it maps into', () => {
    // A row cannot outlive the corpus seat it maps to. If the corpus renames or
    // drops the target, this reds and the alias is deleted, not left rotting.
    for (const [type, map] of Object.entries(payloadKeyAliases())) {
      const def = defFor(type);
      expect(def, `${type} has a codemap def`).toBeDefined();
      for (const [from, to] of Object.entries(map)) {
        expect(Object.keys(def?.properties ?? {}), `${type}: ${from} → ${to} must land on a declared property`).toContain(to);
        expect(Object.keys(def?.properties ?? {}), `${type}: ${from} must NOT be declared (else the alias is a no-op hiding a real emit)`).not.toContain(from);
      }
    }
  });

  it('renames, never overwrites a present target, and returns the same reference when idle', () => {
    expect(applyPayloadKeyAliases('artifact.created', { artifactTypeId: 'deck', versionId: 'v3' })).toEqual({ artifactType: 'deck', version: 'v3' });
    const both = { artifactTypeId: 'deck', artifactType: 'PRODUCER' };
    expect(applyPayloadKeyAliases('artifact.created', both)).toEqual({ artifactTypeId: 'deck', artifactType: 'PRODUCER' });
    const idle = { conversationId: 'c1' };
    expect(applyPayloadKeyAliases('conversation.exchanged', idle)).toBe(idle);
  });
});

describe('ADR 0722 — the ONE composed major-2 projection', () => {
  it('runs ids → aliases → owner echo, and the owner echo sees the final object', () => {
    const out = projectV2Payload('run.started', { workflowId: 'wf', owner: { tenant: 't1', principal: 'u1', principalKind: 'user' } }, { runId: 'r1' }, 't1') as Record<string, unknown>;
    // The v1 owner block (principal/principalKind) is rebuilt into the closed v2 shape.
    expect(Object.keys(out.owner as object).sort()).toEqual(['subject', 'tenant']);
    expect((out.owner as { tenant: string }).tenant).toBe('t1');
  });

  it('projected run.started VALIDATES against runStarted (the 156 were an unprojected-channel artefact)', () => {
    const validate = validatorFor('runStarted');
    const raw = { workflowId: 'conformance-noop', owner: { tenant: 'acme', principal: 'user:abc', principalKind: 'user', subject: { issuer: 'urn:openwop:legacy', subjectId: 'user:abc', tenant: 'acme', lane: 'api-key', kind: 'user' } } };
    // `lane: 'api-key'` is what `legacySubject()` stamps (`host/runOwner.ts:146`); a
    // first draft of this fixture invented `lane: 'legacy'` and blamed the projection.
    expect(validate(raw), 'the PERSISTED block is v1 and fails the v2 def by design').toBe(false);
    expect(validate(projectV2Payload('run.started', raw, { runId: 'r1' }, 'acme')), 'the PROJECTED block is the wire truth and must validate').toBe(true);
  });
});

describe('ADR 0722 — A.1: the workforce seed writes decision values the enum admits', () => {
  it('granted / rejected validate; approve / reject do not', () => {
    const validate = validatorFor('approvalGranted');
    const base = { nodeId: 'n1', interruptId: 'acme/7f3a9c1e-2b4d-4a6f-8e10-9c2d5b7a1f04' };
    expect(validate({ ...base, decision: 'granted' })).toBe(true);
    expect(validate({ ...base, decision: 'rejected' })).toBe(true);
    expect(validate({ ...base, decision: 'approve' }), 'the pre-ADR-0721 value must stay refused').toBe(false);
    const src = readFileSync(join(here, '..', 'src', 'host', 'workforceHistory.ts'), 'utf8');
    expect(src).not.toMatch(/decision: '(approve|reject)'/);
  });
});

describe('ADR 0722 — A.5: the demo subscription id is inside the opaque grammar', () => {
  it('for a plain tenant AND an anon tenant, deterministically', () => {
    const OPAQUE = /^[A-Za-z0-9._~-]{16,128}$/;
    for (const t of ['acme', 'anon:s7Kq2mVx9Lp4', 'a:b:c']) {
      const id = demoAutoIngestSubscriptionId(t);
      expect(id, `${t} → ${id}`).toMatch(OPAQUE);
      expect(id).toBe(demoAutoIngestSubscriptionId(t));
    }
    expect(demoAutoIngestSubscriptionId('acme')).not.toBe(demoAutoIngestSubscriptionId('acme2'));
  });
});
