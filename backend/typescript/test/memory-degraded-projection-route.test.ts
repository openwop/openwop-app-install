/**
 * RFC 0080 §C — the memory degraded projection on the NORMATIVE `GET /v1/agents`.
 *
 * The corpus scenario (`memory-degraded-projection`, gated on
 * `agents.manifestRuntime` + `memory.supported`) runs against this host's
 * conformance boot, which selects `OPENWOP_SURFACE_MEMORY=durable`. There every
 * memoryShape-requestable dimension is satisfied, so it proves the §C-1
 * NON-degraded direction and nothing else — the position RFC 0080's amended
 * acceptance criterion describes, and the reason it does not demand more.
 *
 * **This file proves the other direction, and does it honestly.** It boots the
 * app on the host's DEFAULT (process-local) memory tier — a shipped
 * configuration, the one `app.openwop.dev` actually runs — where
 * `long-term-durability` is genuinely absent, so an agent declaring
 * `memoryShape.longTerm` is genuinely degraded. Nothing is fabricated: the
 * agents are ordinary, the stamp is the truth about that deployment. That is the
 * "honest host that genuinely lacks a dimension" the RFC says will exercise the
 * degraded-STAMP direction.
 *
 * Both lanes into the inventory are covered, because both can hide a silent
 * satisfied-looking entry (§C-2 makes that non-conformant regardless of lane):
 *   - the REGISTRY lane (`toEntry`) — pack + boot-hydrated agents;
 *   - the READ-THROUGH lane (`userRecordToEntry`) — a durable user agent on an
 *     instance whose registry has not hydrated it (simulated by removing the
 *     registry row while the durable row stays).
 *
 * The response is validated against the corpus
 * `agent-inventory-response.schema.json` — from `@openwop/openwop-conformance`,
 * not the repo's vendored copy, so the assertion cannot certify against a
 * contract that has moved.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import Ajv2020 from 'ajv/dist/2020.js';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { MEMORY_DIMENSIONS } from '../src/host/memoryDimensions.js';
import { corpusSchema } from './support/corpusSchema.js';

const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
/** Bearer callers resolve to the shared `default` tenant (bearer-shared posture). */
const TENANT = 'default';

/** A pack-style agent that WANTS a cross-run durable store. Registered through
 *  the same `register()` call `packs/agentLoader.ts` makes — not a special
 *  inventory path. */
const LONG_TERM_AGENT = 'test.h51.long-term-wanter';
/** A pack-style agent that wants only the tier-independent read/write adapter. */
const SCRATCHPAD_AGENT = 'test.h51.scratchpad-only';

let BASE: string;
let server: http.Server;
const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

interface Entry {
  agentId: string;
  memoryShape?: { scratchpad?: boolean; conversation?: boolean; longTerm?: boolean };
  memoryDegraded?: unknown;
  degradedMemoryDimensions?: unknown;
  [k: string]: unknown;
}

const listAgents = async (): Promise<{ agents: Entry[]; total: number }> =>
  (await (await fetch(`${BASE}/v1/agents`, { headers: H })).json()) as { agents: Entry[]; total: number };

beforeAll(async () => {
  setEnv('OPENWOP_STORAGE_DSN', 'memory://');
  setEnv('OPENWOP_AUTH_DISABLE_COOKIES', 'true');
  // THE AXIS OF THIS FILE: the DEFAULT memory tier. Both vars are cleared, not
  // just one — `resolveBackendId` consults the per-surface var first and the
  // global one second, so clearing only one leaves the tier to ambient env (the
  // flake H49 removed by construction rather than by diagnosis).
  setEnv('OPENWOP_SURFACE_MEMORY', undefined);
  setEnv('OPENWOP_SURFACE_BACKEND', undefined);

  const registry = getAgentRegistry();
  registry.register({
    agentId: LONG_TERM_AGENT,
    persona: 'Long Term Wanter',
    modelClass: 'general',
    systemPrompt: 'Wants a cross-run durable store.',
    packName: 'test.h51',
    packVersion: '0',
    toolAllowlist: [],
    memoryShape: { scratchpad: true, conversation: true, longTerm: true },
  });
  registry.register({
    agentId: SCRATCHPAD_AGENT,
    persona: 'Scratchpad Only',
    modelClass: 'general',
    systemPrompt: 'Wants ephemeral notes only.',
    packName: 'test.h51',
    packVersion: '0',
    toolAllowlist: [],
    memoryShape: { scratchpad: true, conversation: false, longTerm: false },
  });

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  getAgentRegistry().remove(LONG_TERM_AGENT, TENANT);
  getAgentRegistry().remove(SCRATCHPAD_AGENT, TENANT);
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('RFC 0080 §C — the degraded STAMP, on the tier that genuinely lacks the dimension', () => {
  it('stamps a longTerm agent with exactly long-term-durability', async () => {
    const { agents } = await listAgents();
    const a = agents.find((e) => e.agentId === LONG_TERM_AGENT);
    expect(a, 'the registered agent MUST appear in the inventory').toBeDefined();
    expect(a!.memoryDegraded).toBe(true);
    expect(a!.degradedMemoryDimensions).toEqual(['long-term-durability']);
    // NOT `read`/`write`: the four-op adapter is tier-independent, so an
    // over-broad stamp would be as wrong as a missing one.
    expect(a!.degradedMemoryDimensions).not.toContain('read');
    expect(a!.degradedMemoryDimensions).not.toContain('write');
  });

  it('leaves a scratchpad-only agent unstamped — the fields are ABSENT', async () => {
    const { agents } = await listAgents();
    const a = agents.find((e) => e.agentId === SCRATCHPAD_AGENT);
    expect(a).toBeDefined();
    // The counterfactual that makes the leg above mean something: same host,
    // same tier, same request — a different memoryShape, and no stamp.
    expect(Object.hasOwn(a!, 'memoryDegraded'), '§C-1: absent ⇒ fully satisfied').toBe(false);
    expect(Object.hasOwn(a!, 'degradedMemoryDimensions')).toBe(false);
  });

  it('every route that projects an inventory entry carries the same stamp', async () => {
    // FOUR registrations project the entry: the two normative ones §C binds to,
    // plus the two host-extension aliases the CLI reads. They share
    // `toEntry`/`listVisibleAgents` today, so this is a route-level pin against a
    // future divergence — an alias "optimized" to its own projection would be a
    // silent satisfied-looking entry on a surface a real client uses.
    const paths = [
      `/v1/agents/${encodeURIComponent(LONG_TERM_AGENT)}`,
      `/v1/host/openwop-app/agents/${encodeURIComponent(LONG_TERM_AGENT)}`,
    ];
    for (const p of paths) {
      const one = (await (await fetch(`${BASE}${p}`, { headers: H })).json()) as Entry;
      expect(one.memoryDegraded, p).toBe(true);
      expect(one.degradedMemoryDimensions, p).toEqual(['long-term-durability']);
    }
    // ...and the LIST form of the alias, which goes through `userRecordToEntry`
    // for read-through rows as well.
    const aliasList = (await (await fetch(`${BASE}/v1/host/openwop-app/agents`, { headers: H })).json()) as { agents: Entry[] };
    const fromAlias = aliasList.agents.find((e) => e.agentId === LONG_TERM_AGENT);
    expect(fromAlias?.degradedMemoryDimensions).toEqual(['long-term-durability']);
  });
});

describe('RFC 0080 §C — the READ-THROUGH lane is projected too', () => {
  it('a durable user agent absent from this instance\'s registry is still stamped', async () => {
    // Create through the real route (durable row + registry row), then drop ONLY
    // the registry row — exactly the cold-instance state `listVisibleAgents`
    // read-through exists for. Without the projection in `userRecordToEntry`,
    // this agent would come back looking fully satisfied.
    const created = await fetch(`${BASE}/v1/host/openwop-app/agents`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        persona: 'H51 Read Through',
        modelClass: 'chat',
        systemPrompt: 'A user-authored agent that wants long-term memory.',
        memoryShape: { scratchpad: true, conversation: true, longTerm: true },
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { agentId } = (await created.json()) as { agentId: string };

    // Precondition: while it IS hydrated, the registry lane already stamps it.
    const hydrated = (await listAgents()).agents.find((e) => e.agentId === agentId);
    expect(hydrated?.memoryDegraded, 'precondition: the registry lane stamps it').toBe(true);

    const removed = getAgentRegistry().remove(agentId, TENANT);
    expect(removed, 'the registry row MUST have been dropped for this to test read-through').toBe(true);

    const coldEntry = (await listAgents()).agents.find((e) => e.agentId === agentId);
    expect(coldEntry, 'the durable row MUST still be served by read-through').toBeDefined();
    expect(coldEntry!.memoryDegraded).toBe(true);
    expect(coldEntry!.degradedMemoryDimensions).toEqual(['long-term-durability']);
  });
});

describe('RFC 0080 §C — the iff-contract over the WHOLE inventory (the corpus scenario\'s own assertion)', () => {
  it('every entry satisfies stamped ⇔ non-empty closed-enum unique dimensions', async () => {
    const { agents, total } = await listAgents();
    // Non-vacuity, the same guard the corpus scenario opens with.
    expect(agents.length, 'an advertising + serving host MUST expose its inventory').toBeGreaterThanOrEqual(1);
    expect(total).toBe(agents.length);

    let stamped = 0;
    for (const a of agents) {
      const dims = a.degradedMemoryDimensions;
      if (a.memoryDegraded === true) {
        stamped += 1;
        expect(Array.isArray(dims) && dims.length >= 1, `${a.agentId}: stamped ⇒ non-empty`).toBe(true);
        for (const d of dims as string[]) expect(MEMORY_DIMENSIONS as readonly string[]).toContain(d);
        expect(new Set(dims as string[]).size).toBe((dims as string[]).length);
      } else {
        expect(dims === undefined || (Array.isArray(dims) && dims.length === 0), `${a.agentId}: unstamped ⇒ no dimensions`).toBe(true);
      }
    }
    // This host reaches the degraded branch on this tier — the property that
    // makes the loop evidence rather than a shape check over an all-clean set.
    expect(stamped, 'the default tier MUST produce at least one degraded entry').toBeGreaterThan(0);
  });

  it('the response validates against the corpus agent-inventory-response schema', async () => {
    const schema = corpusSchema('agent-inventory-response.schema.json');
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const body = await listAgents();
    if (!validate(body)) {
      throw new Error(`GET /v1/agents violated agent-inventory-response.schema.json: ${ajv.errorsText(validate.errors)}`);
    }
    // Non-vacuity: `additionalProperties:false` on the entry means the schema
    // really is constraining what we send. Prove the validator rejects something.
    expect(validate({ agents: [{ ...body.agents[0], degradedMemoryDimensions: ['not-a-dimension'] }], total: 1 })).toBe(false);
  });
});

describe('RFC 0080 §A/§B — the advertisement the projection is bound to', () => {
  it('/.well-known/openwop advertises memory.supported true with writable OMITTED', async () => {
    const doc = (await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json()) as {
      capabilities: { memory?: Record<string, unknown>; agents?: { memoryBackends?: unknown } };
    };
    const mem = doc.capabilities.memory;
    expect(mem?.supported).toBe(true);
    // Absent ⇒ writable (RFC 0080 UQ1). Setting it false would be untrue here AND
    // would withhold the derived `openwop-memory` profile.
    expect(Object.hasOwn(mem!, 'writable'), 'writable MUST be omitted, not false').toBe(false);
    // The tier under test has no durable memory, so the backend claim is absent —
    // which is precisely why the agents above are degraded. Advert and projection
    // are one derivation; this asserts they agree on the wire.
    expect(doc.capabilities.agents?.memoryBackends).toBeUndefined();
  });
});
