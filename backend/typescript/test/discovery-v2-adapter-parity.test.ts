/**
 * The SPA reads discovery at major 2 through ONE adapter
 * (`frontend/react/src/client/capabilitiesV2Adapter.ts`). This test is the gate
 * that ADR 0730 C.3 did not have.
 *
 * C.3 moved the read to v2 and shipped five silent UI regressions, because every
 * consumer meets a missing field with a `catch` or an `undefined` that renders
 * nothing. `adr0730-v2-superset-of-spa-reads.test.ts` proves each field is
 * PRESENT at major 2; that is necessary and was not enough, since present-but-
 * different reads the same as absent to a consumer written against v1.
 *
 * ADR 0812 P4 — THE ORACLE IS FROZEN. Until P4 this file compared `adapt(v2)`
 * with the v1 document built in-process, per configuration. The v1 builder is
 * deleted, so the values v1 gave each consumer read are now PINNED LITERALS,
 * captured from `adapt(v2)` on the commit where this file was last green
 * against the live v1 builder (`51f5a323f`) — i.e. the values that were proven
 * equal to v1. A row that fails is still the finding: the adapter or the advert
 * changed what a consumer reads. Re-pin only for a deliberate advert change,
 * and say so in the commit.
 *
 * The configurations are the auth ones, because that is where the documents
 * were derived by different code: default, SAML + SCIM with the combined
 * subject-linking contract, and SAML + SCIM without it (RFC 0164 drops SCIM).
 *
 * THE PATH LIST IS HAND-MAINTAINED, for the reason the superset test gives: a
 * grep-derived list silently under-counts. Adding a consumer read? Add its row.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { maxStreamAgeSec } from '../src/host/streamAgeCapability.js';
import { defaultMaxAgeMs } from '../src/host/sseChannel.js';

import { createApp } from '../src/index.js';
import { adaptV2Capabilities } from '../../../frontend/react/src/client/capabilitiesV2Adapter.js';

/**
 * Every path a consumer reads, who reads it, and the value v1 gave it in EVERY
 * configuration (frozen oracle, ADR 0812 P4). The two config-dependent reads
 * (`demoMode`, the auth profiles) are pinned per configuration in `CONFIGS`.
 */
const CONSUMER_READS: ReadonlyArray<readonly [path: string, consumer: string, expected: unknown]> = [
  ['feedback.supported', 'client/feedbackClient.ts', true],
  ['feedback.targets', 'client/feedbackClient.ts', ['run', 'event', 'node']],
  ['feedback.signals', 'client/feedbackClient.ts', ['rating', 'correction', 'label', 'flag']],
  ['capabilities.prompts.supported', 'prompts/promptsClient.ts', true],
  ['capabilities.envelopes.tierOneSubsetCompliance', 'prompts/PromptLibraryPage.tsx, discovery/CapabilitiesPanel.tsx', 'warn'],
  ['capabilities.envelopes.reasoning.supported', 'discovery/CapabilitiesPanel.tsx', true],
  ['capabilities.envelopes.reasoning.promptDirective', 'discovery/CapabilitiesPanel.tsx', 'advisory'],
  ['capabilities.memory.attribution.emitsWriteEvents', 'runs/RunMemoryPanel.tsx', true],
  ['capabilities.modelCapabilities.supported', 'discovery/CapabilitiesPanel.tsx', true],
  ['capabilities.modelCapabilities.substitutionSupported', 'discovery/CapabilitiesPanel.tsx', false],
  // Re-pin when the model-capability SSoT deliberately changes.
  ['capabilities.modelCapabilities.advertised', 'builder/inspector/inspectorHelpers.ts, discovery/CapabilitiesPanel.tsx',
    ['discriminator-enum', 'function-calling', 'long-context', 'reasoning', 'structured-output', 'vision-input']],
  ['capabilities.aiProviders.input.modalities', 'discovery/CapabilitiesPanel.tsx', ['text', 'image', 'document', 'audio']],
  ['implementation', 'discovery/CapabilitiesPanel.tsx', { name: 'test', version: '0.0.1', vendor: 'openwop-app' }],
];

/** The config-dependent reads, pinned per configuration below. */
const AUTH_PROFILE_READS = [
  ['auth.profiles', 'auth/AuthCard.tsx, features/users/SsoPanel.tsx, runs/RunOpsPanel.tsx, runs/RunAuditPage.tsx'],
  ['capabilities.auth.profiles', 'discovery/CapabilitiesPanel.tsx'],
] as const;

/**
 * Reads where v1 and the adapter DELIBERATELY differed. Each is asserted on its
 * own, so a difference that changes shape cannot hide here.
 */
const DELIBERATE = {
  // v1 serves `limits` at the root only, so `capabilities.limits` (which
  // builderShellHelpers reads) was always undefined and the limits banner never
  // rendered. The adapter fills it with the root value v1 served.
  limits: 'capabilities.limits',
  // v2 does not advertise the optional `envelopes.reliability` family, and has
  // no interrupt-profile list. Only the wire-diagnostics panel reads either,
  // and it now shows the v2 truth.
  absentAtV2: ['capabilities.envelopes.reliability', 'capabilities.profiles'],
} as const;

function at(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** A host surface as a consumer uses it: InMemoryHostBanner filters on supported + implementation (the in-memory disclosure); CapabilitiesPanel lists names. */
function surfaceView(list: unknown): unknown {
  return Array.isArray(list)
    ? list.map((s: Record<string, unknown>) => ({ name: s.name, supported: s.supported, implementation: s.implementation })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    : list;
}

const CONFIGS: ReadonlyArray<{ name: string; env: Record<string, string>; demoMode: boolean; profiles: string[] }> = [
  { name: 'default', env: {}, demoMode: false, profiles: [] },
  // Demo mode rides this config so `demoMode` is `true` in at least one run.
  // Every other config serves `false`, and an adapter that dropped the field
  // would read as `false` too, which is how C.3 lost the BYOK affordance.
  {
    name: 'SAML + SCIM, combined subject-linking, demo mode',
    env: { OPENWOP_DEMO_MODE: 'true', OPENWOP_TEST_SAML_IDP_URL: 'http://127.0.0.1:9/idp', OPENWOP_TEST_SCIM_URL: 'http://127.0.0.1:9/scim' },
    demoMode: true,
    profiles: ['openwop-auth-saml', 'openwop-auth-scim'],
  },
  {
    name: 'SAML + SCIM, NO shared trust root (RFC 0164 drops SCIM)',
    env: { OPENWOP_TEST_SAML_IDP_URL: 'http://127.0.0.1:9/idp', OPENWOP_SCIM_BEARER: 'parity-test-bearer' },
    demoMode: false,
    profiles: ['openwop-auth-saml'],
  },
];
const TOUCHED = [...new Set(CONFIGS.flatMap((c) => Object.keys(c.env)))];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

let server: Server;
let base = '';
const APP_CONFIG = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };

async function fetchV2(): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/.well-known/openwop`, {
    headers: { Authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp(APP_CONFIG);
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);   // a boot dies at the HOOK timeout, which --testTimeout does not raise

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe.each(CONFIGS)('adapt(v2 discovery) gives every consumer read the value v1 gave it — $name', ({ env, demoMode, profiles }) => {
  let v2: Record<string, unknown>;
  let adapted: Record<string, unknown>;

  async function load(): Promise<void> {
    Object.assign(process.env, env);
    v2 = await fetchV2();
    // The closed v2 root has no `capabilities` block and carries `auth.lanes`.
    expect(v2.capabilities, 'the versioned read must be the v2 document').toBeUndefined();
    expect(at(v2, 'auth.lanes'), 'the versioned read must be the v2 document').toBeDefined();
    adapted = adaptV2Capabilities(v2);
  }

  it.each(CONSUMER_READS)('%s (read by %s)', async (path, _consumer, expected) => {
    await load();
    expect(at(adapted, path), `${path}: the adapter gives a consumer something other than what v1 gave it`).toEqual(expected);
  });

  it.each(AUTH_PROFILE_READS)('%s (read by %s) — pinned for this config', async (path) => {
    await load();
    expect(at(adapted, path)).toEqual(profiles);
  });

  it('demoMode (read by client/demoMode.ts, agents/AgentDashboardPage.tsx) — pinned for this config', async () => {
    await load();
    expect(at(adapted, 'demoMode')).toBe(demoMode);
  });

  it('host surfaces: a named list with the supported flag and implementation every consumer reads', async () => {
    // The surface list moves with the host's composition, so it is asserted by
    // STRUCTURE rather than pinned: InMemoryHostBanner filters on `supported` +
    // `implementation`, CapabilitiesPanel lists `name`.
    await load();
    const view = surfaceView(at(adapted, 'capabilities.hostSurfaces')) as Array<{ name: unknown; supported: unknown; implementation: unknown }>;
    expect(Array.isArray(view)).toBe(true);
    expect(view.length).toBeGreaterThan(10);
    for (const s of view) {
      expect(typeof s.name, JSON.stringify(s)).toBe('string');
      expect(typeof s.supported, JSON.stringify(s)).toBe('boolean');
      expect(typeof s.implementation, JSON.stringify(s)).toBe('string');
    }
    expect(view.map((s) => s.name)).toEqual(expect.arrayContaining(['host.aiProviders', 'host.kvStorage', 'host.interrupts']));
  });

  it('deliberate: capabilities.limits carries the root limits (v1 left it undefined)', async () => {
    await load();
    expect(at(adapted, DELIBERATE.limits)).toEqual({
      clarificationRounds: 5, schemaRounds: 3, envelopesPerTurn: 32,
      maxNodeExecutions: 1000, maxRunDurationMs: 600000, maxRequestBodyBytes: 1048576,
      // ADR 0897 P4 / RFC 0247 — from the advert's one source (300 with the
      // default; absent when the host does not bound). The consumer
      // (builderShellHelpers) reads named fields, so this member claims nothing
      // a v1 reader relied on.
      ...(maxStreamAgeSec(defaultMaxAgeMs()) !== undefined ? { maxStreamAgeSec: maxStreamAgeSec(defaultMaxAgeMs()) } : {}),
    });
  });

  it.each(DELIBERATE.absentAtV2)('deliberate: %s is absent at v2 and stays absent (never invented)', async (path) => {
    await load();
    expect(at(adapted, path)).toBeUndefined();
  });
});

describe('the configurations actually differ — otherwise the three runs above are one run three times', () => {
  it('auth.profiles moves with the config', async () => {
    const seen: string[] = [];
    for (const { env } of CONFIGS) {
      for (const k of TOUCHED) delete process.env[k];
      Object.assign(process.env, env);
      seen.push(JSON.stringify(at(adaptV2Capabilities(await fetchV2()), 'auth.profiles')));
    }
    expect(new Set(seen).size, `profiles per config: ${seen.join(' | ')}`).toBe(CONFIGS.length);
  });

  it('demoMode is true in at least one config — else its row passes for an adapter that drops it', async () => {
    const seen: unknown[] = [];
    for (const { env } of CONFIGS) {
      for (const k of TOUCHED) delete process.env[k];
      Object.assign(process.env, env);
      seen.push(at(adaptV2Capabilities(await fetchV2()), 'demoMode'));
    }
    expect(seen).toContain(true);
    expect(seen).toContain(false);
  });
});
