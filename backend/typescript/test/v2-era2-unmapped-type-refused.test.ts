import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/index.js';
import { orgsFromDeclaration, reservedOrgs } from '../src/host/specDeclaration.js';
import { locateRepoSchemasDir } from '../src/host/_repoPath.js';

/**
 * `spec/v2/core/persistence.md` §"The reader rule" — an era-2 event type the
 * codemap does not name and that carries no reserved vendor prefix MUST fail the
 * read with `event_type_unmapped` (500). "The rule binds every reader: poll, SSE,
 * fork, replay divergence, debug bundle, summary memory."
 */
let server: Server;
let base: string;
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };

/**
 * The type the corpus scenario uses, and the choice matters more than it looks.
 *
 * My first draft used `totally.unmapped.type`, which MATCHES this host's
 * `isVendorType` grammar — so a 200 was the correct answer to a badly chosen
 * input, and the "failure" was my witness, not the host. `foo.bar` is the
 * corpus's own fixture: two segments, no registered org.
 */
const UNMAPPED = 'foo.bar';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** Seed an era-2 log whose middle row carries a type no codemap row names. */
async function seedUnmapped(): Promise<string> {
  const res = await fetch(`${base}/conformance/seams/sample/event-log/seed`, {
    method: 'POST',
    headers: V2,
    body: JSON.stringify({
      eventLogSchemaVersion: 2,
      status: 'completed',
      events: [
        { sequence: 0, type: 'run.started', payload: {} },
        { sequence: 1, type: UNMAPPED, payload: {} },
        { sequence: 2, type: 'run.completed', payload: {} },
      ],
    }),
  });
  const body = await res.json() as { runId?: string };
  if (res.status !== 201 || !body.runId) throw new Error(`seed answered ${res.status}: ${JSON.stringify(body)}`);
  return body.runId;
}

describe('the era-2 reader REFUSES a type it cannot translate', () => {
  // UN-SKIPPED 2026-09-13. The condition this block recorded has been MET, so
  // the history is worth keeping short: it was skipped first because suite 2.0.5
  // soft-skipped the corpus leg on every published-layout host, and then because
  // `extensions` in `spec/v2/declaration.json` held only `example` (reserved,
  // never assignable) — tightening `isVendorType` at that point would have
  // refused EVERY vendor-shaped type, and 31 emitted types here would have made
  // any era-2 log carrying one unreadable. The steward ruled against tightening
  // and took the registration procedure through RFC 0180.
  //
  // RFC 0180 landed; `openwop-app` is a registered org as of spec-artifacts
  // 2.0.12; ADR 0682 moved this host's five squatting types under it. So the
  // predicate is now registration-gated (ADR 0687) and this goes green in the
  // same commit that tightened it — exactly as this comment said it would.
  it('GET /runs/{id}/events/poll answers 500 event_type_unmapped, not a tolerant 200', async () => {
    const runId = await seedUnmapped();
    const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers: V2 });
    const body = await res.json().catch(() => null) as { error?: string | { code?: string } } | null;

    expect(
      res.status,
      'the poll reader returned the log instead of refusing it. `toContractVocabulary` already throws '
        + '`event_type_unmapped` — so a 200 here means the READER never reached it, not that the rule is unimplemented. '
        + `body: ${JSON.stringify(body).slice(0, 300)}`,
    ).toBe(500);
    // The corpus reads the code through `readErrorCode`, which accepts BOTH
    // `{error:'code'}` and `{error:{code}}`. This host emits the flat form, and
    // my first draft asserted only the nested one — so it failed on a host that
    // was answering correctly. Mirror the helper rather than pick a shape.
    const code = typeof body?.error === 'string' ? body.error : body?.error?.code;
    expect(code, 'the refusal MUST name the registered error code').toBe('event_type_unmapped');
  });

  it('a MAPPED era-2 log still reads cleanly — the refusal is not a blanket era-2 refusal', async () => {
    // Non-vacuity in the dangerous direction: a reader that refused every era-2
    // log would pass the leg above while breaking every legitimate v1 run.
    const res = await fetch(`${base}/conformance/seams/sample/event-log/seed`, {
      method: 'POST',
      headers: V2,
      body: JSON.stringify({
        eventLogSchemaVersion: 2,
        status: 'completed',
        events: [
          { sequence: 0, type: 'run.started', payload: {} },
          { sequence: 1, type: 'run.completed', payload: {} },
        ],
      }),
    });
    const { runId } = await res.json() as { runId: string };
    const poll = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers: V2 });
    expect(poll.status, 'a fully mappable era-2 log MUST still read').toBe(200);
  });

  it('a REGISTERED vendor type still passes through — the gate is registration, not shape', async () => {
    // The leg that makes the first one mean something. Both legs above pass
    // against a predicate that returns false for EVERYTHING: the refusal leg
    // wants a refusal, and the mapped leg carries no vendor type at all. Only a
    // registered vendor type reaching the reader unchanged shows that the new
    // gate discriminates rather than simply denies.
    //
    // `openwop-app.node.message` is one of the three types ADR 0682 renamed
    // that STAYED vendor-namespaced, and `openwop-app` is a registered org in
    // the vendored declaration.
    //
    // This used to seed `openwop-app.ai.message-chunk`, and ADR 0688 moved that
    // one to the codemap type `output.chunk` — which would have made this leg
    // assert pass-through on a type the codemap now NAMES, i.e. it would have
    // measured translation and called it pass-through. A control that stops
    // being a control is worse than no control.
    const res = await fetch(`${base}/conformance/seams/sample/event-log/seed`, {
      method: 'POST',
      headers: V2,
      body: JSON.stringify({
        eventLogSchemaVersion: 2,
        status: 'completed',
        events: [
          { sequence: 0, type: 'run.started', payload: {} },
          { sequence: 1, type: 'openwop-app.node.message', payload: {} },
          { sequence: 2, type: 'run.completed', payload: {} },
        ],
      }),
    });
    const { runId } = await res.json() as { runId: string };
    const poll = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers: V2 });
    expect(poll.status, 'a registered vendor type MUST read at contract 2').toBe(200);
    const body = await poll.json() as { events?: Array<{ type?: string }> };
    expect(
      (body.events ?? []).map((e) => e.type),
      'a vendor type passes through under its OWN name — it is not translated',
    ).toContain('openwop-app.node.message');
  });
});

/**
 * The registry read itself, ADR 0687 § Blocker 1. These are unit legs on the
 * pure half — the route legs above cannot reach them, because a doctored
 * declaration file would have to exist on disk.
 */
describe('the vendor-org registry refuses to read as empty', () => {
  it('an unreadable registry THROWS rather than registering nothing', () => {
    // The direction that matters. An empty set is not "no org is registered" —
    // it refuses EVERY vendor type at contract 2, silently, as a side effect of
    // a corpus pin. `?? {}` made both shapes below read as zero orgs.
    for (const doc of [{}, { extensions: {} }]) {
      expect(
        () => orgsFromDeclaration(doc),
        `${JSON.stringify(doc)} must fail loud, not register nothing`,
      ).toThrow(/unreadable/);
    }
  });

  it('the VENDORED declaration is readable and names openwop-app + example', () => {
    // Non-vacuity, and a live tripwire on the corpus pin: the leg above proves
    // the guard fires, this one proves the guard is not firing on the real file.
    // `example` is asserted explicitly because it is `reserved: true` and a
    // future reader filtering reserved orgs would red the corpus control leg.
    const orgs = orgsFromDeclaration(
      JSON.parse(readFileSync(join(locateRepoSchemasDir(fileURLToPath(new URL('.', import.meta.url)), 'run-event.schema.json'), 'v2', 'declaration.json'), 'utf8')) as { extensions?: Record<string, unknown> },
    );
    expect(orgs.has('openwop-app'), 'RFC 0180 — this host is a registered org from spec-artifacts 2.0.12').toBe(true);
    expect(orgs.has('example'), 'the corpus control leg seeds example.thing-happened').toBe(true);
  });

  it('the reserved-org list comes from the FILE — the literal mirror had drifted', () => {
    // The guard that did not exist. `discoveryExtensions` carried
    // `new Set(['openwop','vendor'])` as a hand copy while the pinned file
    // listed four, so `registerV2Extension` accepted `effect-seams.*` and
    // `events.*`. A literal mirror of a pinned artifact has no failure mode —
    // it just disagrees quietly at the next bump. Assert the two the drift
    // dropped, so a future re-mirroring reds here.
    const reserved = reservedOrgs();
    for (const org of ['openwop', 'vendor', 'effect-seams', 'events']) {
      expect(reserved.has(org), `${org} is reserved in spec/v2/declaration.json`).toBe(true);
    }
  });
});
