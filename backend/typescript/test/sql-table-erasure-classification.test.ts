/**
 * ADR 1043 RELAY-LOG-RETENTION-1 — every SQL table is CLASSIFIED for subject
 * erasure, so a new subject-bearing table fails the build the day it is written.
 *
 * Why this file exists: the ADR 0464 coverage ratchet
 * (`subject-erasure-coverage.test.ts`) enumerates only `new DurableCollection`
 * namespaces under `src/host`, and the teardown guard
 * (`teardown-child-drift-guard.test.ts`) proves only that tenant teardown reaches
 * a table. Nothing classified the SQL tables themselves for ERASURE, which is how
 * `messaging_delivery_log` (a contact id per row) shipped with no delete path but
 * teardown.
 *
 * The population is every `CREATE TABLE` in BOTH `storage/{sqlite,postgres}/schema.ts`.
 * Each table lands in exactly one list:
 *  - ERASED        — a registered, manifest-listed `SubjectEraser` deletes its
 *                    subject rows; each storage method named is pinned to a
 *                    `DELETE FROM <table>` in BOTH adapters.
 *  - TORN_DOWN     — no subject data beyond the tenant; tenant teardown is its
 *                    delete path. Pinned: it has a `tenant_id` column (so the ADR
 *                    0284 introspection reaches it). Empty today: no table was
 *                    verified into it.
 *  - EXEMPT        — no subject data at all; carries its reason.
 *  - UNCLASSIFIED_PRE_EXISTING — tables that existed before this ratchet and were
 *                    NOT audited for it. Allowed, shrink-only: a new table may not
 *                    be added here (the ceiling below), and an entry leaves only by
 *                    being classified for real.
 *
 * Red when: a table is in no list or in two, a list names a table that no longer
 * exists, the pre-existing list grows past its ceiling, an ERASED eraser is not in
 * the manifest, or an ERASED storage method stops deleting from its table in
 * either backend.
 * Sabotage-witnessed 2026-11-04: renaming the `messaging_delivery_log` ERASED
 * entry turned "every table is in exactly one list" red (and the eraser-pin and
 * tenant_id cases, which then read a table that does not exist). That run also
 * showed the stale-entry case passing over a bogus name: the lists were `.keys()`
 * iterators, spent by the first case. Fixed to arrays and re-witnessed: the same
 * rename now reds the stale-entry case too. Re-witnessed 2026-11-05
 * (/grade-tests w89) from the product side: a new `CREATE TABLE` in either schema
 * file reds "exactly one list"; a storage method that UPDATEs instead of DELETEs
 * (either backend) or a dropped manifest entry reds the ERASED case; renaming
 * `messaging_delivery_log.tenant_id` reds the tenant_id case.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/storage/sqlite/schema.js';
import { EXPECTED_SUBJECT_ERASERS } from '../src/host/subjectEraserManifest.js';

const STORAGE = join(__dirname, '..', 'src', 'storage');
const read = (p: string): string => readFileSync(join(STORAGE, p), 'utf8');
const SCHEMAS = { sqlite: read('sqlite/schema.ts'), postgres: read('postgres/schema.ts') };
const ADAPTERS = { sqlite: read('sqlite/index.ts'), postgres: read('postgres/index.ts') };

interface Erased { eraser: string; methods: readonly string[]; why: string }

const ERASED = new Map<string, Erased>([
  ['messaging_delivery_log', {
    eraser: 'eraseRelayDeliveryLogSubject',
    methods: ['deleteDeliveryLogForConversation', 'deleteDeliveryLogForRelay', 'pruneDeliveryLog'],
    why: 'conversation_id is the contact a relay talked to: erased on an exact match (and the device owner\'s rows via eraseRelayOwnerSubject); aged out at 7 days; deleted on revoke',
  }],
]);

const TORN_DOWN = new Map<string, string>();

const EXEMPT = new Map<string, string>([
  ['__schema_version', 'one row: the schema migration number and when it was applied'],
  ['__app_meta', 'app version and app-migration markers (host/appVersion.ts, host/appMigrations.ts); no tenant, no subject'],
]);

/** Not audited by this ratchet. Shrink-only — see the ceiling. */
const UNCLASSIFIED_PRE_EXISTING = new Set([
  'agent_run_activity', 'annotations', 'audit_log', 'byok_chat_usage', 'byok_secrets', 'byok_tenant_secrets',
  'chat_messages', 'chat_sessions', 'dispatch_outbox', 'effect_escape_ledger', 'envelope_correlations', 'events',
  'host_ext_kv', 'idempotency', 'idempotent_response', 'interrupts', 'invocation_claim', 'invocation_log',
  'managed_provider_usage', 'media_provider_usage', 'messaging_allowlist', 'messaging_connectors',
  'messaging_identities', 'messaging_pairings', 'messaging_policies', 'messaging_routing_rules', 'messaging_sessions',
  'messaging_turns', 'notifications', 'push_subscriptions', 'relay_devices', 'relay_outbound', 'run_budget', 'runs',
  'user_agents', 'user_agents_v2', 'webhook_deliveries', 'webhooks', 'workflows', 'workspace_files',
]);
/** Measured 2026-11-04 (40). Lower it when an entry is classified; never raise it. */
const UNCLASSIFIED_CEILING = 40;

const CREATE_RE = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_0-9]+)/gi;
function tablesIn(src: string): Set<string> {
  return new Set([...src.matchAll(CREATE_RE)].map((m) => m[1]!));
}
const tables = new Set([...tablesIn(SCHEMAS.sqlite), ...tablesIn(SCHEMAS.postgres)]);

/** The body of `async <name>(` in an adapter, up to the next method. */
function methodBody(src: string, name: string): string {
  const at = src.indexOf(`async ${name}(`);
  if (at < 0) return '';
  const next = src.indexOf('\n    async ', at + 1);
  return src.slice(at, next < 0 ? undefined : next);
}

describe('SQL tables are classified for subject erasure (RELAY-LOG-RETENTION-1)', () => {
  // Arrays, not `.keys()` iterators: an iterator is spent by the first case that reads it.
  const lists: Array<[string, readonly string[]]> = [
    ['ERASED', [...ERASED.keys()]], ['TORN_DOWN', [...TORN_DOWN.keys()]], ['EXEMPT', [...EXEMPT.keys()]],
    ['UNCLASSIFIED_PRE_EXISTING', [...UNCLASSIFIED_PRE_EXISTING]],
  ];

  it('scans a real population (both schema files)', () => {
    expect(tables.size).toBeGreaterThanOrEqual(43);
    expect(tables.has('messaging_delivery_log')).toBe(true);
    expect(tablesIn(SCHEMAS.postgres).has('messaging_delivery_log')).toBe(true);
  });

  it('every table is in exactly one list', () => {
    const where = new Map<string, string[]>();
    for (const [name, list] of lists) for (const t of list) where.set(t, [...(where.get(t) ?? []), name]);
    const unclassified = [...tables].filter((t) => !where.has(t)).sort();
    const doubled = [...where].filter(([, ls]) => ls.length > 1).map(([t, ls]) => `${t} (${ls.join(' + ')})`);
    expect(unclassified, 'Unclassified SQL table(s): add a SubjectEraser (ERASED), or classify TORN_DOWN/EXEMPT with a verified reason. Never add a new table to UNCLASSIFIED_PRE_EXISTING.').toEqual([]);
    expect(doubled).toEqual([]);
  });

  it('no list names a table that no longer exists', () => {
    const stale: string[] = [];
    for (const [name, list] of lists) for (const t of list) if (!tables.has(t)) stale.push(`${name}: ${t}`);
    expect(stale).toEqual([]);
  });

  it('the pre-existing unclassified list only shrinks', () => {
    expect(UNCLASSIFIED_PRE_EXISTING.size).toBeLessThanOrEqual(UNCLASSIFIED_CEILING);
  });

  it('an ERASED table names a manifest-listed eraser and storage methods that delete from it in both backends', () => {
    const broken: string[] = [];
    for (const [table, e] of ERASED) {
      if (!EXPECTED_SUBJECT_ERASERS.has(e.eraser)) broken.push(`${table}: ${e.eraser} is not in EXPECTED_SUBJECT_ERASERS`);
      for (const m of e.methods) {
        for (const [backend, src] of Object.entries(ADAPTERS)) {
          if (!methodBody(src, m).includes(`DELETE FROM ${table}`)) broken.push(`${table}: ${backend} ${m} does not DELETE FROM ${table}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('a TORN_DOWN or ERASED table has a tenant_id column, so tenant teardown reaches it', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const cols = (t: string): string[] => (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as Array<{ name: string }>).map((r) => r.name);
    const missing = [...TORN_DOWN.keys(), ...ERASED.keys()].filter((t) => !cols(t).includes('tenant_id'));
    expect(missing).toEqual([]);
  });
});
