/**
 * ADR 0858 P2 — every family seat in the v2 capabilities schema is either
 * EMITTED by this host's v2 discovery document, or named in a shrink-only ledger
 * with the reason it is not.
 *
 * Why this exists: `whd7-v2-projection-parity` compares facets only WITHIN the
 * families v2 already emits, so a family missing entirely was outside its
 * universe. That is how 18+ families the v1 document advertised (a2a, mcp,
 * httpClient, the storage families, …) went undiscoverable when production
 * retired v1 on 2026-10-03, and why every major-2 scenario gated on them
 * recorded `inapplicable`.
 *
 * The oracle is the v2 SCHEMA's seat list, not the v1 document, so this survives
 * ADR 0812 P3c deleting `buildAdvertisement`.
 *
 * The probe turns every operator-gated surface it can ON, so a gated family is
 * inside the check rather than excused by a default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { loadConfigFromEnv } from '../src/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';

type Rec = Record<string, unknown>;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const GATED_ON: Readonly<Record<string, string>> = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_A2A_SERVER_ENABLED: 'true',
  OPENWOP_MCP_SERVER_ENABLED: 'true',
  OPENWOP_MULTI_AGENT_EXECUTION_MODEL: 'true',
  OPENWOP_PORTABILITY_ENABLED: 'true',
  OPENWOP_TEST_SANDBOX_MVP: 'true',
  OPENWOP_TEST_SEAM_ENABLED: 'true',
  OPENWOP_HOST_EVENTS_V2: 'true',
  // ADR 0858 P3 slice 3 — the operator gates of three families now projected.
  // Each only lights its own family (dataResidency / anonymousActor /
  // authorization); `adr0858-slice3-families.test.ts` holds every one honest
  // and schema-valid under exactly this posture.
  OPENWOP_DATA_RESIDENCY_ENABLED: 'true',
  OPENWOP_DATA_RESIDENCY_REGIONS: 'eu,us',
  OPENWOP_ANON_ACTOR_ENABLED: 'true',
  OPENWOP_AUTHORIZATION_ENFORCEMENT: 'true',
};

const BLOCKED = 'ADR 0858 P1: blocked by host work (P4) — projecting it today would be a false claim';
const GATED = 'operator-gated surface this probe does not enable: confirm its predicate projects it when on';
const A2A_GAP = 'ADR 0858 P4 behaviour gap: the P1 blockers are fixed (refreshedAt + ratchet, negotiation.decided, legacy profile filtered, major-2 version rules) and the record is built (`v2A2aRecord`), but projecting it fails `v2-a2a-operation-map` (10 legs) and `v2-a2a-push-delivery` (4 legs) on the A2A 1.0 server; flip `V2_PROJECT_A2A` (host/a2aProfile.ts) once they pass — a deliberate, announced change: it also moves the inbound card/codec to 1.0 for live third-party 0.3 clients';
const MCP_GAP = 'ADR 0858 P4 behaviour gap: the P1 blockers are fixed and the record is built (`v2McpRecord`), but `v2-minimum-version-refused` (mcp) records blocked — the floor 2025-06-18 is the lowest revision the suite can offer — and the mount fails `v2-mcp-mount-map` (5 legs) and `v2-mcp-tasks`; flip `V2_PROJECT_MCP` once they pass';
const UNDISPOSITIONED = 'ADR 0858 P1 follow-up: not yet dispositioned (is it served? are its required facets honoured?)';
const WORKSPACE_GAP = 'ADR 0858 P4 (re-measured 2026-10-10): host-services.md §workspace MUST emit `workspace.updated` on each write or delete, and nothing in src/ emits it; projecting the record would be a false claim';

/**
 * SHRINK-ONLY. A family that starts being emitted MUST be deleted from here in
 * the same change (the staleness leg reds otherwise), and a seat the corpus adds
 * that this host does not emit reds the coverage leg until it is dispositioned.
 */
const KNOWN_UNEMITTED_FAMILIES: Readonly<Record<string, string>> = {
  a2a: A2A_GAP,
  mcp: MCP_GAP,
  workspace: WORKSPACE_GAP,
  portability: BLOCKED,
  sandbox: BLOCKED,
  oauth: GATED,
  i18n: GATED,
  content: GATED,
  channelPresence: GATED,
  envelopeContracts: UNDISPOSITIONED,
  nodePackRuntimes: UNDISPOSITIONED,
  selfHostedRunner: UNDISPOSITIONED,
  purposePropagation: UNDISPOSITIONED,
  credentials: UNDISPOSITIONED,
  fs: UNDISPOSITIONED,
  nosql: UNDISPOSITIONED,
  heartbeat: UNDISPOSITIONED,
  toolHooks: UNDISPOSITIONED,
  aiEnvelope: UNDISPOSITIONED,
  promptLibrary: UNDISPOSITIONED,
  agentRuntime: UNDISPOSITIONED,
  budget: UNDISPOSITIONED,
  nondeterminismPolicy: UNDISPOSITIONED,
  searchIndex: UNDISPOSITIONED,
  production: UNDISPOSITIONED,
  auditLogIntegrity: UNDISPOSITIONED,
};

/** The family seats the v2 schema declares: root records requiring the §3 envelope. */
function familySeats(): string[] {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'v2', 'capabilities.schema.json'), 'utf8')) as { properties: Rec };
  const deref = (x: unknown): Rec | undefined => {
    const r = x as Rec | undefined;
    if (r && typeof r['$ref'] === 'string' && (r['$ref'] as string).startsWith('#/')) {
      return deref((r['$ref'] as string).slice(2).split('/').reduce<unknown>((o, k) => (o as Rec)[k], schema));
    }
    return r;
  };
  return Object.entries(schema.properties).filter(([, v]) => {
    const d = deref(v);
    const req = (d?.['required'] as string[] | undefined) ?? [];
    return d?.['type'] === 'object' && req.includes('status') && req.includes('witness');
  }).map(([k]) => k);
}

const saved = new Map<string, string | undefined>();
let emitted: Set<string>;
let seats: string[];

beforeAll(() => {
  for (const [k, v] of Object.entries(GATED_ON)) { saved.set(k, process.env[k]); process.env[k] = v; }
  // The conformance nodes register in this (test) posture, as on the reference
  // deploy, so the storage families the probe covers are emitted (ADR 0858 P3).
  ensureNodesRegistered();
  emitted = new Set(Object.keys(buildV2Advertisement(loadConfigFromEnv())));
  seats = familySeats();
});
afterAll(() => {
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('ADR 0858 — every v2 family seat is emitted or ledgered', () => {
  it('reads a real seat list and a real document (non-vacuous)', () => {
    expect(seats.length).toBeGreaterThanOrEqual(70);
    expect(seats.filter((s) => emitted.has(s)).length).toBeGreaterThanOrEqual(34);
  });

  it('no seat is silently unemitted: each missing family is in the ledger, with a reason', () => {
    const silent = seats.filter((s) => !emitted.has(s) && !(s in KNOWN_UNEMITTED_FAMILIES));
    expect(silent, `the v2 schema has a seat for these, this host emits none, and nobody decided why — project them (ADR 0858) or ledger them with the reason: ${silent.join(', ')}`).toEqual([]);
  });

  it('the ledger is shrink-only: an entry that is emitted now must be deleted', () => {
    const stale = Object.keys(KNOWN_UNEMITTED_FAMILIES).filter((f) => emitted.has(f));
    expect(stale, `emitted now — delete from KNOWN_UNEMITTED_FAMILIES: ${stale.join(', ')}`).toEqual([]);
    const unknown = Object.keys(KNOWN_UNEMITTED_FAMILIES).filter((f) => !seats.includes(f));
    expect(unknown, `not a v2 family seat — a typo, or the corpus removed it: ${unknown.join(', ')}`).toEqual([]);
  });

  it('ADR 0858 P3: the honour-able host-service families are emitted', () => {
    for (const f of ['httpClient', 'conversationTurnModelProvenance', 'deadLetter', 'artifactTypes', 'multiPartyConversation', 'providerUsage', 'queueBus', 'subWorkflow', 'dataResidency', 'anonymousActor', 'authorization']) {
      expect(emitted.has(f), f).toBe(true);
    }
  });
});
