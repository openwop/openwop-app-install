/**
 * ADR 0858 P3 slice 3 — `subWorkflow`, `dataResidency`, `anonymousActor` and
 * `authorization` on the v2 root, each from the SAME source its behaviour reads.
 *
 * The `subWorkflow` legs are the load-bearing ones: `execution.md` §subWorkflow
 * says a host NOT advertising `subWorkflow.inputMapping` MUST refuse a non-empty
 * `inputMapping` at registration with `validation_error`. Before this slice the
 * v2 root carried no `subWorkflow` record at all while the register-time check
 * read an overlay flag that defaults `true` — so v2 ACCEPTED a mapping it did
 * not advertise. Both now read `subWorkflowInputMappingHonoured()`; the legs
 * below parameterise that one fact and assert the advert and the refusal move
 * together in both directions.
 *
 * Tracker TST-BFA-8. Red when: the registration refusal or the advert stops
 * reading `subWorkflowInputMappingHonoured()`; an EMPTY mapping is refused;
 * dataResidency is advertised with no regions or with duplicates; the
 * authorization record is projected with enforcement off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { setCapabilityOverlay, subWorkflowInputMappingHonoured } from '../src/host/capabilityOverlay.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import type { AppConfig } from '../src/index.js';
import { OpenwopError } from '../src/types.js';
import { BUILT_IN_ROLE_IDS } from '../src/host/accessControlService.js';

type Rec = Record<string, unknown>;
const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };
const V2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2');
const doc = (): Rec => buildV2Advertisement(CONFIG) as Rec;

const ENV_KEYS = [
  'OPENWOP_DATA_RESIDENCY_ENABLED',
  'OPENWOP_DATA_RESIDENCY_REGIONS',
  'OPENWOP_ANON_ACTOR_ENABLED',
  'OPENWOP_AUTHORIZATION_ENFORCEMENT',
] as const;
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  setCapabilityOverlay('subWorkflow.inputMapping', undefined);
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const allOff = (): void => { for (const k of ENV_KEYS) delete process.env[k]; };
const allOn = (): void => {
  process.env.OPENWOP_DATA_RESIDENCY_ENABLED = 'true';
  process.env.OPENWOP_DATA_RESIDENCY_REGIONS = 'eu, us,eu';
  process.env.OPENWOP_ANON_ACTOR_ENABLED = 'true';
  process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT = 'true';
};

interface MappingDef {
  workflowId: string;
  nodes: Array<{ nodeId: string; typeId: string; config: { workflowId: string; inputMapping: Record<string, string> } }>;
}
const mappingDef = (): MappingDef => ({
  workflowId: 'wf.adr0858.subworkflow-mapping',
  nodes: [{ nodeId: 'child', typeId: 'core.subWorkflow', config: { workflowId: 'wf.child', inputMapping: { receivedPrdId: 'currentPrdId' } } }],
});

describe('ADR 0858 slice 3 — subWorkflow: the advert and the refusal read ONE fact', () => {
  it('fact TRUE (the default): the advert carries inputMapping and a mapping is accepted', () => {
    expect(subWorkflowInputMappingHonoured()).toBe(true);
    expect(doc()['subWorkflow']).toMatchObject({ inputMapping: true });
    expect(() => validateWorkflowDefinition(mappingDef())).not.toThrow();
  });

  it.each([true, false])('fact=%s: advertised ⇔ accepted (execution.md §subWorkflow)', (fact) => {
    setCapabilityOverlay('subWorkflow.inputMapping', fact);
    const rec = doc()['subWorkflow'] as Rec | undefined;
    // The family itself is always served; only the facet tracks the fact.
    expect(rec, 'subWorkflow record').toBeDefined();
    expect(rec?.['inputMapping'] === true).toBe(fact);
    if (!fact) expect(rec && 'inputMapping' in rec, 'omitted, not false').toBe(false);
    let refusal: unknown;
    try { validateWorkflowDefinition(mappingDef()); } catch (e) { refusal = e; }
    if (fact) {
      expect(refusal).toBeUndefined();
    } else {
      expect(refusal).toBeInstanceOf(OpenwopError);
      expect((refusal as OpenwopError).code).toBe('validation_error');
      expect((refusal as OpenwopError).details).toMatchObject({ requiredCapability: 'subWorkflow.inputMapping' });
    }
  });

  it('an EMPTY inputMapping is never refused, whatever the fact', () => {
    setCapabilityOverlay('subWorkflow.inputMapping', false);
    const def = mappingDef();
    def.nodes[0]!.config.inputMapping = {};
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });
});

describe('ADR 0858 slice 3 — the three operator-gated families', () => {
  it('gates OFF (the prod posture): none of the three is on the v2 root', () => {
    allOff();
    const d = doc();
    for (const f of ['dataResidency', 'anonymousActor', 'authorization']) expect(d[f], f).toBeUndefined();
  });

  it('dataResidency: enabled with no regions stays dark (no empty claim)', () => {
    allOff();
    process.env.OPENWOP_DATA_RESIDENCY_ENABLED = 'true';
    process.env.OPENWOP_DATA_RESIDENCY_REGIONS = '';
    expect(doc()['dataResidency']).toBeUndefined();
  });

  it('gates ON: each record carries exactly its v2 facets, from the behaviour source', () => {
    allOn();
    const d = doc();
    const facets = (r: unknown): Rec => {
      const { status: _s, since: _si, until: _u, witness: _w, ...rest } = r as Rec;
      return rest;
    };
    expect(facets(d['dataResidency'])).toEqual({ regions: ['eu', 'us'] });
    expect(facets(d['anonymousActor'])).toEqual({ tiers: ['read', 'bounded-write-egress'], writeEgressControls: ['hitl'], failClosed: true });
    const authz = facets(d['authorization']);
    expect(authz['failClosed']).toBe(true);
    expect((authz['roles'] as Array<{ role: string }>).map((r) => r.role)).toEqual([...BUILT_IN_ROLE_IDS]);
    for (const f of ['subWorkflow', 'dataResidency', 'anonymousActor', 'authorization']) {
      expect(JSON.stringify(d[f]), `${f} carries no v1 \`supported\``).not.toContain('"supported"');
    }
  });

  it('gates ON: the whole v2 document still validates against the v2 schema', () => {
    allOn();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const f of readdirSync(V2)) {
      if (!f.endsWith('.json')) continue;
      try { ajv.addSchema(JSON.parse(readFileSync(join(V2, f), 'utf8')) as Rec, f); } catch { /* sibling's problem */ }
    }
    const root = JSON.parse(readFileSync(join(V2, 'capabilities.schema.json'), 'utf8')) as { $id?: string };
    const validate = (root.$id ? ajv.getSchema(root.$id) : undefined) ?? ajv.getSchema('capabilities.schema.json');
    if (!validate) throw new Error('capabilities.schema.json did not register — the validator would be vacuous');
    const d = doc();
    const ok = validate(d);
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message} ${JSON.stringify(e.params)}`);
    expect(errors, errors.join('\n')).toEqual([]);
    expect(ok).toBe(true);
    for (const f of ['subWorkflow', 'dataResidency', 'anonymousActor', 'authorization']) expect(d[f], f).toBeDefined();
  });
});
