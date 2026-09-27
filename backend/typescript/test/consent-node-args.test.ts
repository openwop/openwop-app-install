/**
 * WF-CONS-3 — the consent gate's own witness.
 *
 * The ONE pre-existing witness (`consent-route.test.ts`, "check + record run
 * over a stub ctx.features.consent") drives both nodes with a COMPLETE, VALID
 * argument set, through `inputs` only, on a hand-built ctx. So neither the
 * missing-subject lane nor the `config` channel was supplied by anything, and
 * the fabrication was invisible by construction.
 *
 * This file drives both nodes through BOTH RFC 0013 Path-A channels and asserts
 * the gate fails TYPED rather than answering a manufactured verdict as
 * `status:'success'` — with CONTROL arms proving a genuinely-empty-but-VALID
 * input still answers `success`, so the fix cannot rot into "always refuse".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  __resetConsentStore, getConsent, recordConsent, setPolicy,
} from '../src/features/consent/consentService.js';
import { buildConsentSurface } from '../src/features/consent/surface.js';

type NodeFn = (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>;

let server: http.Server;
let nodes: Record<string, NodeFn>;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  // The gate is permissive when the `consent` toggle is off, so the fabrication
  // is only reachable — and this file only meaningful — with the regime ON.
  const d = getToggleDefault('consent');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  const mod = await import('../../../packs/feature.consent.nodes/index.mjs');
  nodes = mod.nodes as Record<string, NodeFn>;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The tenant whose policy makes the fabrication VISIBLE: with no record,
 *  `isAllowed` falls to `defaultMode === 'opt-out'` ⇒ `true`. */
const T = 'consent-node-args';
beforeEach(async () => {
  await __resetConsentStore();
  await setPolicy(T, { defaultMode: 'opt-out' });
});

const surf = () => buildConsentSurface({ tenantId: T });
/** The two channels RFC 0013 Path A can freeze a `{{params.X}}` token into. */
const viaInputs = (i: Record<string, unknown>) => ({ features: { consent: surf() }, inputs: i });
const viaConfig = (c: Record<string, unknown>) => ({ features: { consent: surf() }, config: c });

const check = (ctx: unknown) => nodes['feature.consent.nodes.check']!(ctx);
const record = (ctx: unknown) => nodes['feature.consent.nodes.record']!(ctx);

describe('WF-CONS-3 — the gate never fabricates a verdict', () => {
  it('an ABSENT subjectKey throws instead of answering `allowed:true` as a success', async () => {
    // Before: `inputs()` coerced the missing subject to `''`, `isAllowed` missed
    // `${tenantId}:` and fell to `defaultMode === 'opt-out'`, and the node
    // returned `{status:'success', outputs:{allowed:true}}` — a fabricated
    // authorisation for a person the gate never received, which a consuming
    // chain cannot tell apart from a real grant.
    await expect(check(viaInputs({ category: 'marketing' })))
      .rejects.toThrow(/`subjectKey` must be a non-empty string/);
  });

  it('a BLANK/whitespace subjectKey throws too (the coercion had no trim either)', async () => {
    await expect(check(viaInputs({ subjectKey: '   ', category: 'marketing' })))
      .rejects.toThrow(/`subjectKey` must be a non-empty string/);
  });

  it('an ABSENT category throws instead of silently evaluating `analytics`', async () => {
    // The old `inputs()` defaulted a missing category to `'analytics'`, so the
    // node answered a question nobody asked and LABELLED it `analytics`.
    await expect(check(viaInputs({ subjectKey: 's1' })))
      .rejects.toThrow(/`category` MUST be one of/);
  });

  it('an UNRECOGNIZED category throws and NAMES the enum', async () => {
    // `str(args.category) as ConsentCategory` was an unchecked cast: a typo met
    // no record and took the same `opt-out` branch ⇒ a fabricated `true` for a
    // category that does not exist.
    const r = check(viaInputs({ subjectKey: 's1', category: 'markting' }));
    await expect(r).rejects.toThrow(/`category` MUST be one of/);
    await expect(r).rejects.toThrow(/marketing\.whatsapp/);
  });

  it('CONTROL: a VALID subject with NO consent record still answers `success` (opt-out ⇒ true)', async () => {
    // The genuinely-empty-but-valid case. The fix must distinguish "no subject
    // was supplied" from "this subject has no record yet" — not refuse both.
    const r = await check(viaInputs({ subjectKey: 'never-heard-of-them', category: 'marketing' }));
    expect(r.status).toBe('success');
    expect(r.outputs!.allowed).toBe(true);
    expect(r.outputs!.category).toBe('marketing');
  });

  it('CONTROL: a recorded DENIAL still answers `success` with `allowed:false`', async () => {
    await recordConsent({ tenantId: T, subjectKey: 's1', categories: { analytics: false, marketing: false }, source: 'test' });
    const r = await check(viaInputs({ subjectKey: 's1', category: 'marketing' }));
    expect(r.status).toBe('success');
    expect(r.outputs!.allowed).toBe(false);
  });
});

describe('WF-CONS-3 — the write lane records something, or fails typed', () => {
  it('an ABSENT subjectKey throws instead of writing a row keyed `${tenantId}:`', async () => {
    await expect(record(viaInputs({ categories: { analytics: true } })))
      .rejects.toThrow(/`subjectKey` must be a non-empty string/);
  });

  it('a categories block with NOTHING recordable throws', async () => {
    // `partialCategories` silently drops every unrecognised key, so this used to
    // answer `status:'success'` having recorded none of what was asked — while
    // still clearing the subject's erasure tombstone.
    await expect(record(viaInputs({ subjectKey: 's1', categories: { marketting: true } })))
      .rejects.toThrow(/at least one recordable boolean/);
    await expect(record(viaInputs({ subjectKey: 's1' })))
      .rejects.toThrow(/at least one recordable boolean/);
    expect(await getConsent(T, 's1')).toBeNull();
  });

  it('CONTROL: an all-FALSE (fully-denying) update is meaningful and still succeeds', async () => {
    // "Empty" in the compliance sense — the subject grants nothing — is a
    // legitimate write and must not be confused with "the caller said nothing".
    const r = await record(viaInputs({ subjectKey: 's1', categories: { analytics: false, marketing: false } }));
    expect(r.status).toBe('success');
    expect((r.outputs!.categories as Record<string, unknown>).marketing).toBe(false);
    expect((await getConsent(T, 's1'))!.categories.marketing).toBe(false);
  });
});

describe('WF-CONS-3 — a param frozen into `config` reaches the node (Path A)', () => {
  it('check: works through `config` alone', async () => {
    await recordConsent({ tenantId: T, subjectKey: 's1', categories: { analytics: true, marketing: true }, source: 'test' });
    const r = await check(viaConfig({ subjectKey: 's1', category: 'marketing' }));
    expect(r.status).toBe('success');
    expect(r.outputs!.allowed).toBe(true);
  });

  it('record: works through `config` alone', async () => {
    const r = await record(viaConfig({ subjectKey: 's-cfg', categories: { marketing: true } }));
    expect(r.status).toBe('success');
    expect((await getConsent(T, 's-cfg'))!.categories.marketing).toBe(true);
  });

  it('INPUTS WIN over config on a conflict (a DAG value is a runtime fact)', async () => {
    const ctx = {
      features: { consent: surf() },
      config: { subjectKey: 's-config-default', categories: { marketing: true } },
      inputs: { subjectKey: 's-runtime' },
    };
    await record(ctx);
    expect(await getConsent(T, 's-config-default')).toBeNull();
    expect((await getConsent(T, 's-runtime'))!.categories.marketing).toBe(true);
  });

  it('CONTROL: the `inputs` channel still works (the merge must not break the old lane)', async () => {
    const r = await record(viaInputs({ subjectKey: 's-inputs', categories: { analytics: true } }));
    expect(r.status).toBe('success');
    expect((await getConsent(T, 's-inputs'))!.categories.analytics).toBe(true);
  });
});
