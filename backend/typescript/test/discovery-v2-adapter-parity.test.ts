/**
 * The SPA reads discovery at major 2 through ONE adapter
 * (`frontend/react/src/client/capabilitiesV2Adapter.ts`). This test is the gate
 * that ADR 0730 C.3 did not have.
 *
 * C.3 moved the read to v2 and shipped five silent UI regressions, because every
 * consumer meets a missing field with a `catch` or an `undefined` that renders
 * nothing. `adr0730-v2-superset-of-spa-reads.test.ts` proves each field is
 * PRESENT at major 2; that is necessary and was not enough, since present-but-
 * different reads the same as absent to a consumer written against v1. This test
 * proves the stronger property: served from the same host in the same
 * configuration, `adapt(v2)` gives every consumer-read path the value v1 gave it.
 *
 * The configurations are the auth ones, because that is where the two
 * documents are derived by different code: default, SAML + SCIM with the
 * combined subject-linking contract, and SAML + SCIM without it (RFC 0164
 * drops SCIM). The third is the case that found a real v2 over-claim.
 *
 * THE PATH LIST IS HAND-MAINTAINED, for the reason the superset test gives: a
 * grep-derived list silently under-counts. Adding a consumer read? Add its row.
 * A row that fails is the finding. Fix the adapter or the advert, and do not
 * delete the row to make this green.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';
import { v1Advertisement } from './support/v1Advertisement.js';
import { adaptV2Capabilities } from '../../../frontend/react/src/client/capabilitiesV2Adapter.js';

/** Every path a consumer reads, and who reads it. Same path on v1 and on the adapter output. */
const CONSUMER_READS: ReadonlyArray<readonly [path: string, consumer: string]> = [
  ['demoMode', 'client/demoMode.ts, agents/AgentDashboardPage.tsx'],
  ['auth.profiles', 'auth/AuthCard.tsx, features/users/SsoPanel.tsx, runs/RunOpsPanel.tsx, runs/RunAuditPage.tsx'],
  ['capabilities.auth.profiles', 'discovery/CapabilitiesPanel.tsx'],
  ['feedback.supported', 'client/feedbackClient.ts'],
  ['feedback.targets', 'client/feedbackClient.ts'],
  ['feedback.signals', 'client/feedbackClient.ts'],
  ['capabilities.prompts.supported', 'prompts/promptsClient.ts'],
  ['capabilities.envelopes.tierOneSubsetCompliance', 'prompts/PromptLibraryPage.tsx, discovery/CapabilitiesPanel.tsx'],
  ['capabilities.envelopes.reasoning.supported', 'discovery/CapabilitiesPanel.tsx'],
  ['capabilities.envelopes.reasoning.promptDirective', 'discovery/CapabilitiesPanel.tsx'],
  ['capabilities.memory.attribution.emitsWriteEvents', 'runs/RunMemoryPanel.tsx'],
  ['capabilities.modelCapabilities.supported', 'discovery/CapabilitiesPanel.tsx'],
  ['capabilities.modelCapabilities.substitutionSupported', 'discovery/CapabilitiesPanel.tsx'],
  ['capabilities.modelCapabilities.advertised', 'builder/inspector/inspectorHelpers.ts, discovery/CapabilitiesPanel.tsx'],
  ['capabilities.aiProviders.input.modalities', 'discovery/CapabilitiesPanel.tsx'],
  ['implementation', 'discovery/CapabilitiesPanel.tsx'],
];

/**
 * Reads where v1 and the adapter DELIBERATELY differ. Each is asserted on its
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

const CONFIGS: ReadonlyArray<{ name: string; env: Record<string, string> }> = [
  { name: 'default', env: {} },
  // Demo mode rides this config so `demoMode` is `true` in at least one run.
  // Every other config serves `false`, and an adapter that dropped the field
  // would read as `false` too, which is how C.3 lost the BYOK affordance.
  { name: 'SAML + SCIM, combined subject-linking, demo mode', env: { OPENWOP_DEMO_MODE: 'true', OPENWOP_TEST_SAML_IDP_URL: 'http://127.0.0.1:9/idp', OPENWOP_TEST_SCIM_URL: 'http://127.0.0.1:9/scim' } },
  { name: 'SAML + SCIM, NO shared trust root (RFC 0164 drops SCIM)', env: { OPENWOP_TEST_SAML_IDP_URL: 'http://127.0.0.1:9/idp', OPENWOP_SCIM_BEARER: 'parity-test-bearer' } },
];
const TOUCHED = [...new Set(CONFIGS.flatMap((c) => Object.keys(c.env)))];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

let server: Server;
let base = '';
/** The SAME config the app boots with, so the v1 builder describes the same host. */
const APP_CONFIG = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };

async function fetchDoc(major: 1 | 2): Promise<Record<string, unknown>> {
  // ADR 0812 — the v1 document (this file's oracle for what a consumer read before
  // the move) is no longer served once v1 retires; it is read from its builder,
  // which answers in both modes. The v2 document is the served one.
  if (major === 1) return v1Advertisement(APP_CONFIG);
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

describe.each(CONFIGS)('adapt(v2 discovery) == v1 for every consumer read — $name', ({ env }) => {
  let v1: Record<string, unknown>;
  let adapted: Record<string, unknown>;

  async function load(): Promise<void> {
    Object.assign(process.env, env);
    v1 = await fetchDoc(1);
    const v2 = await fetchDoc(2);
    // `protocolVersion` names the host's preferred version on BOTH documents, so
    // it cannot tell them apart. The v1 root nests a `capabilities` block; the
    // closed v2 root has none, and carries the v2-only `auth.lanes`.
    expect(v1.capabilities, 'the builder read must be the v1 document').toBeDefined();
    expect(v2.capabilities, 'the versioned read must be the v2 document').toBeUndefined();
    expect(at(v2, 'auth.lanes'), 'the versioned read must be the v2 document').toBeDefined();
    adapted = adaptV2Capabilities(v2);
  }

  it.each(CONSUMER_READS)('%s (read by %s)', async (path) => {
    await load();
    expect(at(adapted, path), `${path}: the adapter gives a consumer something other than what v1 gave it`).toEqual(at(v1, path));
  });

  it('host surfaces: same names, supported flags and implementations', async () => {
    await load();
    expect(surfaceView(at(adapted, 'capabilities.hostSurfaces'))).toEqual(surfaceView(at(v1, 'capabilities.hostSurfaces')));
  });

  it('deliberate: capabilities.limits carries the root limits v1 served (v1 left it undefined)', async () => {
    await load();
    expect(at(v1, DELIBERATE.limits)).toBeUndefined();
    expect(at(adapted, DELIBERATE.limits)).toEqual(at(v1, 'limits'));
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
      seen.push(JSON.stringify(at(await fetchDoc(1), 'auth.profiles')));
    }
    expect(new Set(seen).size, `profiles per config: ${seen.join(' | ')}`).toBe(CONFIGS.length);
  });

  it('demoMode is true in at least one config — else its row passes for an adapter that drops it', async () => {
    const seen: unknown[] = [];
    for (const { env } of CONFIGS) {
      for (const k of TOUCHED) delete process.env[k];
      Object.assign(process.env, env);
      seen.push(at(await fetchDoc(1), 'demoMode'));
    }
    expect(seen).toContain(true);
    expect(seen).toContain(false);
  });
});
