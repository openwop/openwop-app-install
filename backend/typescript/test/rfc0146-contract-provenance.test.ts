/**
 * RFC 0146 — `contractProvenance` at the discovery root.
 *
 * WHY THE SABOTAGE LEG IS THE ONLY ONE THAT PROVES ANYTHING.
 *
 * "The advert matches the stamp file" is satisfied just as well by a hand-written
 * constant that happens to equal today's value — it would pass now and drift silently on
 * the first bump, which is precisely the defect RFC 0146 exists to detect. So leg 3
 * REWRITES the installed stamp and asserts the advertised value FOLLOWS it. A constant
 * cannot pass that.
 *
 * Leg 2 exists because the conformance scenario `contract-provenance.test.ts` treats a
 * silent host as INAPPLICABLE, not failing — so a green suite against a host that never
 * emits the field proves nothing at all. Presence has to be asserted here, locally, or
 * "conformance is green" is a statement about a test that never ran.
 *
 * Root placement (not the deprecated `capabilities` wrapper, not dotted) is RFC 0073's
 * document-root layout — the same path every other family took, and the one a consumer
 * actually reads.
 */
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { corpusSchema } from './support/corpusSchema.js';
import { corpusStampPath, contractProvenance, readContractProvenanceFrom, __resetContractProvenance } from '../src/host/contractProvenance.js';

let BASE = '';
let server: http.Server;

const boot = async (): Promise<{ srv: http.Server; base: string }> => {
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  return await new Promise((r) => {
    const srv = app.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` }));
  });
};

const advert = async (base: string): Promise<Record<string, unknown>> => {
  const res = await fetch(`${base}/.well-known/openwop`);
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const b = await boot();
  server = b.srv; BASE = b.base;
}, 60_000);

afterAll(async () => { await new Promise<void>((r) => server?.close(() => r())); });

describe('RFC 0146 — contractProvenance', () => {
  it('leg 1: the advert carries it at the ROOT and validates against the vendored declaration', async () => {
    const doc = await advert(BASE);
    expect(doc.contractProvenance).toBeTypeOf('object');

    // Not under the deprecated wrapper, and not dotted — the two shapes RFC 0073 retired.
    const wrapper = doc.capabilities as Record<string, unknown> | undefined;
    expect(wrapper?.contractProvenance).toBeUndefined();
    expect(doc['host.contractProvenance']).toBeUndefined();

    // Compile the FAMILY's sub-schema, not the whole document: capabilities.schema.json
    // $refs siblings (prompt-kind.schema.json et al) that ajv would have to resolve, and
    // this leg is about contractProvenance's declared shape, not the rest of the document.
    // Same approach as artifact-types-advert-conformance.test.ts.
    const caps = corpusSchema('capabilities.schema.json');
    const declared = (caps.properties ?? {})['contractProvenance'] as Record<string, unknown> | undefined;
    expect(declared, 'the installed corpus declares contractProvenance (i.e. the bump landed)').toBeTruthy();

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(declared!);
    if (!validate(doc.contractProvenance)) {
      throw new Error(`contractProvenance failed its declaration: ${ajv.errorsText(validate.errors)}`);
    }
  });

  it('leg 2 (NON-VACUITY): the field is actually present, so the conformance leg is applicable', async () => {
    // The scenario soft-skips a silent host. Without this assertion a green conformance
    // run is compatible with the field never having been emitted once.
    const doc = await advert(BASE);
    const p = doc.contractProvenance as Record<string, unknown>;
    expect(typeof p.suiteVersion).toBe('string');
    expect(typeof p.corpusCommit).toBe('string');
    expect((p.suiteVersion as string).length).toBeGreaterThan(0);
    expect((p.corpusCommit as string).length).toBeGreaterThan(0);

    // …and it reports the INSTALLED package, which is requirement 2's whole content.
    const stampPath = corpusStampPath();
    expect(stampPath).toBeTruthy();
    const stamp = JSON.parse(readFileSync(stampPath!, 'utf8')) as Record<string, string>;
    // The stamp renamed this field at the major — 1.x wrote `suiteVersion`, 2.x
    // writes `version` — so read both spellings here exactly as the host does.
    // The assertion is unchanged in strength: the advertised value must still
    // equal what the INSTALLED stamp says, which is requirement 2's content.
    // Only the key it is read under widens.
    expect(p.suiteVersion).toBe(stamp.suiteVersion ?? stamp.version);
    expect(p.corpusCommit).toBe(stamp.corpusCommit);
  });

  it('leg 3 (SABOTAGE): point the derivation at a STALE stamp and the advertised value follows', async () => {
    const stampPath = corpusStampPath()!;
    const original = readFileSync(stampPath, 'utf8');
    const real = JSON.parse(original) as Record<string, string>;
    let srv: http.Server | undefined;
    try {
      writeFileSync(stampPath, JSON.stringify({
        suiteVersion: '0.0.1-stale', corpusCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      }, null, 2));
      __resetContractProvenance();

      const b = await boot();
      srv = b.srv;
      const p = (await advert(b.base)).contractProvenance as Record<string, unknown>;

      // A constant would still report the real values here. Derivation reports the stale ones.
      expect(p.suiteVersion).toBe('0.0.1-stale');
      expect(p.corpusCommit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      expect(p.suiteVersion).not.toBe(real.suiteVersion);
    } finally {
      writeFileSync(stampPath, original);
      __resetContractProvenance();
      if (srv) await new Promise<void>((r) => srv!.close(() => r()));
    }
  }, 60_000);

  it('leg 4: an unreadable stamp OMITS the field rather than advertising a placeholder', () => {
    // A guessed revision is a false statement about the contract; silence is merely
    // inapplicable. Omission is the honest failure mode, so it is pinned.
    __resetContractProvenance();
    expect(contractProvenance()).toBeTruthy();          // sanity: it resolves normally
    expect(readContractProvenanceFrom('/nonexistent/CORPUS-STAMP.json')).toBeUndefined();
  });
});
