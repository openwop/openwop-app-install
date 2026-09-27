/**
 * PHC-1 / PHCD-2 — the v2 document must be a SUPERSET of what the SPA reads.
 *
 * WHY THIS EXISTS. `v2-family-adverts.test.ts` validates the served root against
 * the CLOSED schema, which proves everything emitted is LEGAL. Nothing proved
 * anything REQUIRED was PRESENT. Those are different properties and only one of
 * them was tested.
 *
 * That asymmetry is not theoretical: ADR 0730 C.3b moved the SPA's
 * `getCapabilities()` to the v2 root on the strength of five families being
 * advertised, and shipped FIVE silent UI regressions — the BYOK "try it free"
 * affordance and the in-memory disclosure banner both vanished, because
 * `demoMode` and `hostSurfaces` had no v2 home. Every consumer meets a missing
 * field with a `catch` that renders nothing, so 16,132 backend tests, both
 * conformance lanes and 5,433 frontend tests passed over it. It took a browser.
 *
 * THE LIST IS DELIBERATELY HAND-MAINTAINED. Deriving it from SPA source was
 * tried and does not work: the reads are spread across optional chains, aliases
 * and destructuring, and a grep-derived list silently under-counts — the same
 * way a `/v1/` grep once reported 10 call sites when 51 of 62 hits were
 * comments. A reviewed literal that a human must update is more honest than a
 * generated one that quietly shrinks.
 *
 * Adding a consumer read? Add its row. If it has no v2 home, that is the finding
 * — do NOT delete the row to make this green.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';

/** `path` is dotted; `[]` segments are not used — every read below is an object walk. */
interface ConsumerRead {
  readonly what: string;      // what the SPA does with it — why its absence matters
  readonly consumer: string;  // the file that reads it
  readonly v2Path: string;    // where it lives on the major-2 document
}

const CONSUMER_READS: readonly ConsumerRead[] = [
  { what: 'gates the BYOK "try it free" host-managed-key affordance', consumer: 'client/demoMode.ts', v2Path: 'extensions.openwop-app\\.host.demoMode' },
  { what: 'gates the in-memory storage disclosure banner', consumer: 'builder/InMemoryHostBanner.tsx', v2Path: 'extensions.openwop-app\\.host-surfaces.surfaces' },
  { what: 'drives the per-provider subscription credential card', consumer: 'byok/SubscriptionCredentialCard.tsx', v2Path: 'extensions.openwop-app\\.ai-providers.subscriptionProviders' },
  { what: 'drives the SSO lane list and the SAML sign-in affordance', consumer: 'auth/AuthCard.tsx, features/users/SsoPanel.tsx', v2Path: 'auth.lanes' },
  { what: 'gates the prompt library surface', consumer: 'prompts/promptsClient.ts', v2Path: 'prompts' },
  { what: 'drives the model-capability inspector panel', consumer: 'builder/inspector/inspectorHelpers.ts', v2Path: 'modelCapabilities' },
  { what: 'drives the accepted-input-modalities display', consumer: 'discovery/CapabilitiesPanel.tsx', v2Path: 'aiProviders.input.modalities' },
  { what: 'drives the run memory-attribution panel', consumer: 'runs/RunMemoryPanel.tsx', v2Path: 'memory.attribution' },
  { what: 'drives the Tier-1 structured-output posture note', consumer: 'prompts/PromptLibraryPage.tsx', v2Path: 'envelopes.tierOneSubsetCompliance' },
  { what: 'drives the builder host-limits banner', consumer: 'builder/builderShellHelpers.ts', v2Path: 'limits' },
];

/** Walk a dotted path where `\.` escapes a literal dot inside one segment. */
function resolve(doc: unknown, path: string): unknown {
  const segments = path.split(/(?<!\\)\./).map((s) => s.replace(/\\\./g, '.'));
  let cur: unknown = doc;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

let server: Server;
let doc: Record<string, unknown> = {};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  doc = await (await fetch(`${base}/.well-known/openwop`, {
    headers: { Authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' },
  })).json() as Record<string, unknown>;
}, 120_000);   // a boot dies at the HOOK timeout, which --testTimeout does not raise

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('PHC-1 — the served v2 document is a superset of what the SPA reads', () => {
  it('the fixture resolved a real v2 document — otherwise every leg below is vacuous', () => {
    expect(Object.keys(doc).length, 'empty document: the boot or the fetch failed').toBeGreaterThan(10);
    expect(doc['protocolVersions'], 'not the discovery document at all').toBeDefined();
  });

  it.each(CONSUMER_READS)('$v2Path resolves — $what', ({ v2Path, consumer }) => {
    expect(
      resolve(doc, v2Path),
      `${v2Path} is ABSENT from the served major-2 document. ${consumer} reads it, and meets a missing value with a catch that renders nothing — so this ships as a silent UI regression, not an error. Either advertise it at major 2 or keep that consumer on the major-1 read.`,
    ).toBeDefined();
  });

  it('the path walker actually walks — a resolver that always returned undefined would fail every leg, one that always returned a value would pass them all', () => {
    expect(resolve(doc, 'protocolVersions')).toBeDefined();
    expect(resolve(doc, 'this.key.does.not.exist')).toBeUndefined();
    expect(resolve(doc, 'extensions.openwop-app\\.host.demoMode')).toBeDefined();
  });
});
