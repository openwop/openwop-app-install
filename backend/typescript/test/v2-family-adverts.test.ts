/**
 * The v2 capability root, validated against the CLOSED schema it must satisfy —
 * and each family record checked against the thing it claims.
 *
 * WHY THIS FILE EXISTS. `capabilities.schema.json` is
 * `additionalProperties: false` with REQUIRED facets per family, so the schema
 * catches a malformed record. What it cannot catch is a well-formed record that
 * is FALSE — `tokenAlgs: ['hs256']` type-checks on a host that mints something
 * else entirely. That is not hypothetical here: this host went months with
 * `interrupt` unadvertised because a docblock said it minted opaque tokens, and
 * the docblock was stale in both of its halves.
 *
 * So every leg below ties a facet to the mechanism it describes, not to a
 * literal. A facet that stops matching its implementation reddens here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';

import { createApp } from '../src/index.js';
import { EFFECT_SEAMS_PATH } from '../src/routes/effectSeams.js';
import { INTERRUPT_TOKEN_ALGS } from '../src/host/interruptToken.js';

let server: Server; let base = ''; let doc: Record<string, any> = {};
const AUTH = { Authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  doc = await (await fetch(`${base}/.well-known/openwop`, { headers: { ...AUTH, 'OpenWOP-Version': '2' } })).json() as Record<string, any>;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('v2 capability root', () => {
  it('validates against the vendored closed schema', async () => {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(process.cwd(), '..', '..', 'schemas', 'v2');
    const schema = JSON.parse(readFileSync(join(root, 'capabilities.schema.json'), 'utf8')) as object;
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    // Register every sibling v2 schema so the root's $refs resolve — the
    // established idiom (`discovery-signing-keys.test.ts`). A hand-picked
    // subset stops compiling the moment the corpus adds a ref, which is how a
    // schema check quietly stops checking.
    for (const f of readdirSync(root).filter((x) => x.endsWith('.schema.json') && x !== 'capabilities.schema.json')) {
      try { ajv.addSchema(JSON.parse(readFileSync(join(root, f), 'utf8'))); } catch { /* duplicate $id */ }
    }
    const validate = ajv.compile(schema);
    expect(validate(doc), `root violates the closed schema: ${JSON.stringify(validate.errors ?? []).slice(0, 800)}`).toBe(true);
    // Non-vacuity: an unknown root key MUST be rejected, or the closed-world
    // property this leg relies on is not actually being enforced.
    expect(validate({ ...doc, notAFamily: {} })).toBe(false);
  });

  it('advertises exactly the families whose obligations this host meets', () => {
    for (const fam of ['interrupt', 'webhooks', 'eventLog', 'packs', 'idempotency']) {
      expect(doc[fam], `${fam} is honoured here and must be claimed`).toBeDefined();
    }
    // `replay` is now CLAIMED (ADR 0637). This assertion used to read
    // `.toBeUndefined()` with the reason "mid-sequence fork is not
    // deterministic", and that reason was measured but MISDIAGNOSED: the fixture
    // behind it is three `core.noop` nodes, and the red was three host defects
    // (no resume snapshot, a duplicated `run.started`, asymmetric divergence
    // cursors) each manufacturing a `replay.diverged` whose random
    // `replayEventId` was the only field that varied. With those fixed the 501 is
    // gone and `replay-fork-arbitrary` passes all three legs.
    //
    // The withheld list is now EMPTY, so this loop is the whole claim.
    expect(doc.replay, 'replay: mid-sequence fork is deterministic as of ADR 0637 and must be claimed').toBeDefined();
  });

  it('the advert and the 501 cannot disagree — a re-introduced refusal must un-claim the family', async () => {
    // The BICONDITIONAL, which the pair of assertions above cannot express on its
    // own: `replay` may be advertised only while a mid-sequence replay fork is
    // actually served. Without this, restoring the `fork_from_seq_unsupported`
    // refusal would leave the advert standing and the host claiming a MUST it
    // answers 501 to — exactly the state this file exists to prevent, and one
    // that no assertion on the discovery document alone can see.
    const create = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: 'conformance-multi-node' }),
    });
    if (create.status !== 201) {
      // Not a silent pass: if the fixture is unavailable the biconditional is
      // untested, and saying so is better than a green that measured nothing.
      throw new Error(`precondition: POST /v1/runs answered ${create.status}, so the fork leg could not be driven`);
    }
    // NOT `/runs/{id}/events` — that endpoint is SSE, and `.json()` on it fails
    // parsing the stream's own `: open` heartbeat comment. Poll the run instead.
    const { runId } = await create.json() as { runId: string };
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}`, { headers: AUTH });
      const st = r.status === 200 ? ((await r.json() as { status?: string }).status ?? '') : '';
      if (st === 'completed' || st === 'failed') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const fork = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}:fork`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'replay', fromSeq: 1 }),
    });
    expect(
      fork.status,
      `the v2 root advertises \`replay\`, so a mid-sequence replay fork MUST NOT be refused; got ${fork.status}. `
        + 'If this is a deliberate re-introduction of the 501, remove the `replay` advert in the same commit.',
    ).toBe(201);
  });

  it('replay.effectSeamsManifest names the route that actually serves it', () => {
    // The literal in the schema is a const, but the point is that the ROUTE and
    // the CLAIM come from one source. Registering the manifest elsewhere while
    // still advertising the const would be the false claim this ties shut.
    expect(doc.replay.effectSeamsManifest).toBe(EFFECT_SEAMS_PATH.replace(/^\/v1/, ''));
    expect(doc.replay.modes).toEqual(['replay', 'branch']);
  });

  it('interrupt.tokenAlgs is the minter’s own array, not a literal', () => {
    expect(doc.interrupt.tokenAlgs).toEqual([...INTERRUPT_TOKEN_ALGS]);
  });

  it('the effect-seam manifest answers at the address the replay facet WILL name', async () => {
    const res = await fetch(`${base}${EFFECT_SEAMS_PATH.replace(/^\/v1/, '')}`, { headers: { ...AUTH, 'OpenWOP-Version': '2' } });
    expect(res.status, 'an advertised facet pointing at a 404 is the defect this whole posture exists to prevent').toBe(200);
    const body = await res.json() as { manifestVersion: string; seams: unknown[] };
    expect(body.manifestVersion).toBe('1');
    expect(body.seams.length).toBeGreaterThan(0);
  });

  it('packs.testMode is claimed only while the mirror is actually enabled', () => {
    expect(doc.packs).toBeDefined();
    expect(doc.packs.testMode, 'the seam surface is on in this harness').toBeDefined();
  });

  it('every advertised family carries the facets its schema requires', async () => {
    const { join } = await import('node:path');
    const schema = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'schemas', 'v2', 'capabilities.schema.json'), 'utf8')) as any;
    const defs = schema.$defs ?? {};
    const res = (n: any, d = 0): any => { while (n && n.$ref && d < 8) { n = defs[String(n.$ref).split('/').pop()!]; d++; } return n; };
    let checked = 0;
    for (const fam of ['interrupt', 'webhooks', 'eventLog', 'packs', 'idempotency']) {
      const node = res(schema.properties[fam]);
      for (const req of node.required ?? []) {
        expect(doc[fam][req], `${fam}.${req} is REQUIRED by the schema`).toBeDefined();
        checked++;
      }
    }
    expect(checked, 'the loop asserted nothing — the schema walk is broken').toBeGreaterThan(11);
  });
});
