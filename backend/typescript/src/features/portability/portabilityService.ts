/**
 * Portability service (RFC 0098) — host-sample, best-effort.
 *
 * Invariants:
 *   - `export-bundle-no-credential-material` — export is refs-only; import
 *     REJECTS (before applying) any bundle whose item payload carries a literal
 *     credential value. Connection references travel as `[REDACTED:<id>]`-style
 *     refs, never plaintext.
 *   - import `?dryRun=true` makes ZERO writes (returns a plan only).
 *   - a `dependsOn` cycle is rejected before applying.
 */

import { EXPORT_KINDS, type ExportBundle, type ExportItem, type ExportKind, type ImportItemResult, type ImportPlan, type ImportResult } from './types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';

/** Cross-instance import dedup (ADR 0039 overlap residual — closed with the
 *  PR #1181 CAS pattern): each item's dedup key is CLAIMED atomically
 *  (insert-if-absent) before its create, so two concurrent imports of the
 *  same bundle resolve to one creator per item. Claims are permanent by
 *  design — import is idempotent-by-content, so a claim never needs release
 *  (a failed create just means the next import re-skips; the find-existing
 *  fast path above each claim keeps the human message precise). */
interface ImportClaim { key: string; tenantId: string; createdAt: string }
const importClaims = new DurableCollection<ImportClaim>('portability:import-claims', (c) => c.key);
async function claimImport(tenantId: string, kind: string, dedupKey: string): Promise<boolean> {
  return importClaims.compareAndSwap(null, { key: `${tenantId}:${kind}:${dedupKey}`, tenantId, createdAt: new Date().toISOString() });
}
// Owning services per kind (static — portability is a LEAF feature; build-time
// cycle checking beats lazy import()). Host services + the email→crm-precedent
// feature imports (prompts, connections).
import { listRoster, createRosterEntry, getRosterEntry } from '../../host/rosterService.js';
import { getAgentProfile, upsertAgentProfile } from '../../host/agentProfileService.js';
import { listOrgs } from '../../host/accessControlService.js';
import { getJob, registerJob, listJobs, scheduleSubject } from '../../host/schedulingService.js';
import { getChart, putChart } from '../../host/orgChartService.js';
import { listEntriesUnfiltered, createEntry, canonicalPromptActor, VALID_VISIBILITY as VALID_PROMPT_VISIBILITY } from '../prompts/promptLibraryService.js';
import { listConnections } from '../connections/connectionsService.js';
import { resolveSubjectAccess, levelSatisfies } from '../../host/subjectAccess.js';

/** Credential-bearing payload keys (case-insensitive) whose literal string value
 *  must NEVER travel in a bundle (refs only). */
const CREDENTIAL_KEYS = new Set(
  ['apikey', 'api_key', 'clientsecret', 'client_secret', 'password', 'passwd', 'secret', 'token', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token', 'privatekey', 'private_key', 'bearer', 'authorization'].map((k) => k.toLowerCase()),
);

/** A redacted ref is allowed; a raw value is not. */
function isRedactedRef(v: unknown): boolean {
  return typeof v === 'string' && /^\[REDACTED:[^\]]+\]$/.test(v);
}

/** Recursively scan a payload for a literal credential value. Returns the
 *  offending key path, or null when clean. */
export function findLiteralCredential(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findLiteralCredential(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (CREDENTIAL_KEYS.has(k.toLowerCase()) && typeof v === 'string' && v.length > 0 && !isRedactedRef(v)) {
        return here;
      }
      const hit = findLiteralCredential(v, here);
      if (hit) return hit;
    }
  }
  return null;
}

export class CredentialMaterialError extends Error {
  constructor(public readonly keyPath: string) {
    super(`Import bundle carries a literal credential value at \`${keyPath}\` — bundles are refs-only (export-bundle-no-credential-material).`);
  }
}

export class DependsOnCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Import bundle has a dependsOn cycle: ${cycle.join(' → ')}.`);
  }
}

export class MalformedBundleError extends Error {}

/** Import fan-out bound: each item is up to one service write under a single
 *  request — cap the bundle so a crafted 10k-item bundle can't drive 10k writes
 *  (422, same class as the other well-formedness rejections). */
const MAX_BUNDLE_ITEMS = 500;

function assertWellFormed(bundle: unknown): asserts bundle is ExportBundle {
  if (!bundle || typeof bundle !== 'object') throw new MalformedBundleError('bundle MUST be an object');
  const b = bundle as Record<string, unknown>;
  if (b.bundleVersion !== '1') throw new MalformedBundleError('bundleVersion MUST be "1"');
  if (!b.source || typeof b.source !== 'object' || typeof (b.source as Record<string, unknown>).origin !== 'string') {
    throw new MalformedBundleError('source.origin is required');
  }
  if (!Array.isArray(b.items)) throw new MalformedBundleError('items MUST be an array');
  if (b.items.length > MAX_BUNDLE_ITEMS) throw new MalformedBundleError(`items exceeds the ${MAX_BUNDLE_ITEMS}-item cap`);
  for (const it of b.items as unknown[]) {
    const item = it as Record<string, unknown>;
    if (typeof item.ref !== 'string' || !EXPORT_KINDS.includes(item.kind as never)) {
      throw new MalformedBundleError('each item MUST have a string ref and a known kind');
    }
  }
}

/** Topological order; throws DependsOnCycleError on a cycle. */
function topoOrder(items: ExportItem[]): string[] {
  const byRef = new Map(items.map((i) => [i.ref, i]));
  const state = new Map<string, 'visiting' | 'done'>();
  const order: string[] = [];
  const stack: string[] = [];
  const visit = (ref: string): void => {
    const s = state.get(ref);
    if (s === 'done') return;
    if (s === 'visiting') {
      const idx = stack.indexOf(ref);
      throw new DependsOnCycleError([...stack.slice(idx), ref]);
    }
    state.set(ref, 'visiting');
    stack.push(ref);
    for (const dep of byRef.get(ref)?.dependsOn ?? []) {
      if (byRef.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(ref, 'done');
    order.push(ref);
  };
  for (const i of items) visit(i.ref);
  return order;
}

/**
 * Validate a bundle for import. Runs BEFORE any apply/scope decision so a leaky
 * bundle is rejected 422 even on `?dryRun=true` (the conformance leg).
 */
export function validateForImport(rawBundle: unknown): { bundle: ExportBundle; order: string[] } {
  assertWellFormed(rawBundle);
  const bundle = rawBundle;
  for (const item of bundle.items) {
    const hit = findLiteralCredential(item.payload, `${item.kind}:${item.ref}.payload`);
    if (hit) throw new CredentialMaterialError(hit);
  }
  const order = topoOrder(bundle.items); // throws on cycle
  return { bundle, order };
}

export function planImport(rawBundle: unknown): ImportPlan {
  const { bundle, order } = validateForImport(rawBundle);
  const byKind: Record<string, number> = {};
  for (const i of bundle.items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  return { dryRun: true, itemCount: bundle.items.length, byKind, order };
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL export/import (LEAK-12, ADR 0039 correction note; RFC 0098 is Accepted —
// this materializes exactly what the wire already promises; the bundle shape,
// refs-only invariant, dryRun/422/403 ordering, and topo semantics are UNCHANGED).
//
// One KindHandler per ExportKind names the SINGLE owning service for that
// entity — export reads it, import materializes through it. Adding a kind is a
// table row, never a fork. Invariants:
//   - refs-only: connection items carry `[REDACTED:<connectionId>]`, never
//     material (and the export re-runs findLiteralCredential on itself).
//   - imported schedules + roster members land DISABLED — a bundle must never
//     start firing triggers on arrival (the inert-import posture).
//   - idempotent: re-importing the same bundle upserts/skips, never duplicates.
//   - per-item isolation: one failed item never aborts the rest; the result
//     reports imported/skipped/failed per item (additive next to the original
//     `{imported, refs}` shape).
// ─────────────────────────────────────────────────────────────────────────────

interface KindHandler {
  /** Export this kind's items for a tenant. `caller` is the acting subject (or
   *  null for an unauthenticated/system export); handlers whose rows carry a
   *  membership-scoped owner MUST drop the ones `caller` cannot read — see the
   *  `schedule` handler (ADR 0608 R2, `CPC-13`). */
  exportItems(tenantId: string, caller: string | null): Promise<ExportItem[]>;
  /** Materialize one item into this tenant. Returns the per-item outcome. */
  importItem(tenantId: string, actor: string, item: ExportItem): Promise<{ status: 'imported' | 'skipped'; message?: string }>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const KIND_HANDLERS: Record<ExportKind, KindHandler> = {
  roster: {
    async exportItems(tenantId) {
      return (await listRoster(tenantId)).map((r) => ({
        kind: 'roster' as const,
        ref: `roster:${r.rosterId}`,
        payload: {
          persona: r.persona,
          agentRef: r.agentRef,
          workflows: r.workflows,
          ...(r.label ? { label: r.label } : {}),
          ...(r.description ? { description: r.description } : {}),
          ...(r.roleKey ? { roleKey: r.roleKey } : {}),
          enabled: r.enabled,
        },
      }));
    },
    async importItem(tenantId, _actor, item) {
      const persona = str(item.payload.persona);
      if (!persona) return { status: 'skipped', message: 'payload.persona missing' };
      // Idempotency: the target host mints its own rosterIds, so dedupe by
      // persona — in the SLUG domain (grade-pass fix: the deterministic
      // `host:<slug>` mint collides case/punctuation-insensitively, so an
      // exact-string compare let a same-slug import fall through to a 409).
      const slugOf = (p: string): string => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const existing = (await listRoster(tenantId)).find((r) => slugOf(r.persona) === slugOf(persona));
      if (existing) return { status: 'skipped', message: `persona '${persona}' already present (${existing.rosterId})` };
      if (!(await claimImport(tenantId, 'roster', persona))) {
        return { status: 'skipped', message: `persona '${persona}' claimed by a concurrent import` };
      }
      const agentRef = (item.payload.agentRef ?? { agentId: 'assistant' }) as Parameters<typeof createRosterEntry>[0]['agentRef'];
      const entry = await createRosterEntry({
        tenantId,
        persona,
        agentRef,
        workflows: strArr(item.payload.workflows),
        ...(str(item.payload.label) ? { label: str(item.payload.label) } : {}),
        ...(str(item.payload.description) ? { description: str(item.payload.description) } : {}),
        ...(str(item.payload.roleKey) ? { roleKey: str(item.payload.roleKey) } : {}),
        // Inert-import posture: imported members start disabled for review.
        enabled: false,
      });
      return { status: 'imported', message: `roster ${entry.rosterId} (disabled for review)` };
    },
  },

  agent: {
    async exportItems(tenantId) {
      // Profiles key off roster entries (no standalone list seam) — enumerate
      // via the roster, the profile's owning axis.
      const items: ExportItem[] = [];
      for (const r of await listRoster(tenantId)) {
        const p = await getAgentProfile(tenantId, r.rosterId);
        if (!p) continue;
        items.push({
          kind: 'agent',
          ref: `agent:${p.profileId}`,
          dependsOn: [`roster:${r.rosterId}`],
          payload: {
            profileId: p.profileId,
            roleKey: p.roleKey,
            ...(p.department ? { department: p.department } : {}),
            ...(p.configParameters ? { configParameters: p.configParameters } : {}),
            ...(p.hitl ? { hitl: p.hitl } : {}),
          },
        });
      }
      return items;
    },
    async importItem(tenantId, _actor, item) {
      const profileId = str(item.payload.profileId);
      const roleKey = str(item.payload.roleKey);
      if (!profileId || !roleKey) return { status: 'skipped', message: 'payload.profileId/roleKey missing' };
      await upsertAgentProfile(tenantId, profileId, {
        roleKey,
        ...(item.payload.department ? { department: item.payload.department as never } : {}),
        ...(item.payload.configParameters && typeof item.payload.configParameters === 'object'
          ? { configParameters: item.payload.configParameters as Record<string, unknown> } : {}),
        ...(Array.isArray(item.payload.hitl) ? { hitl: strArr(item.payload.hitl) } : {}),
        autonomy: { specLevel: 'recommend' },
      });
      return { status: 'imported', message: `profile ${profileId} upserted` };
    },
  },

  'prompt-template': {
    async exportItems(tenantId) {
      const orgs = await listOrgs(tenantId);
      const items: ExportItem[] = [];
      for (const org of orgs) {
        for (const e of await listEntriesUnfiltered(tenantId, org.orgId)) {
          items.push({
            kind: 'prompt-template',
            ref: `pt:${e.entryId}`,
            // The wire has no org concept — carry the org INSIDE the payload.
            payload: {
              name: e.name,
              orgId: org.orgId,
              ...(e.description ? { description: e.description } : {}),
              ...(e.tags?.length ? { tags: e.tags } : {}),
              ...(e.promptRef ? { promptRef: e.promptRef } : {}),
              // ADR 0694 D3b — carry `visibility`. Without it a round-trip CANNOT
              // preserve intent, and any import-side default silently rewrites the
              // ACL of every exported entry. (Note the export itself is unfiltered:
              // co-residency leakage of prompts is the KNOWN, still-open `CPC-16`
              // tracked at routes.ts:66 — this line does not widen that, but it does
              // stop the round trip from ALSO downgrading privacy.)
              visibility: e.visibility,
            },
          });
        }
      }
      return items;
    },
    async importItem(tenantId, actor, item) {
      const name = str(item.payload.name);
      if (!name) return { status: 'skipped', message: 'payload.name missing' };
      const orgId = str(item.payload.orgId) || 'default';
      const promptRef = str(item.payload.promptRef);
      if (!promptRef) return { status: 'skipped', message: 'payload.promptRef missing (required by the prompt library)' };
      // Idempotency: dedupe by (org, name).
      const existing = (await listEntriesUnfiltered(tenantId, orgId)).find((e) => e.name === name);
      if (existing) return { status: 'skipped', message: `prompt '${name}' already present in org ${orgId}` };
      if (!(await claimImport(tenantId, 'prompt', `${orgId}:${name}`))) {
        return { status: 'skipped', message: `prompt '${name}' claimed by a concurrent import` };
      }
      // PLC-7 (ADR 0694 D3a/D3c) — `actor` here is the RAW request subject
      // (`routes.ts` → `callerSubject(req) ?? 'import'` → `req.userId ??
      // principalId`), but `createdBy` is compared against the CANONICAL
      // `user.userId` on every read (`features/prompts/routes.ts:22` →
      // `readableBy`). Stamping the raw id mints a row whose owner no read can
      // ever produce — and combined with the `private` default below that row is
      // readable by NOBODY, while still being re-exported by
      // `listEntriesUnfiltered`. `promptSurface.ts:28-29` documents and fixes this
      // exact hazard for the workflow surface; the fix had never been transferred
      // here. Same rule, deliberately character-for-character.
      // D3c — refuse BEFORE stamping. The `'import'` sentinel would canonicalize to
      // a perfectly real-looking id, which is exactly why it must be rejected here:
      // a subject-less import has no owner to attribute the row to, and a row nobody
      // can read is worse than an import that says it skipped.
      if (!actor || actor === 'import') {
        return { status: 'skipped', message: `prompt '${name}' needs an authenticated importer (no subject on the request)` };
      }
      const owner = canonicalPromptActor(tenantId, actor);
      await createEntry(tenantId, orgId, owner, {
        name,
        promptRef,
        // ADR 0694 D3b, CORRECTED — an earlier draft defaulted an unspecified import
        // to `org`, reasoning that "an import is an org-scoped act". That was WRONG
        // and would have shipped a privacy DOWNGRADE: the exporter did not carry
        // `visibility` at all, so EVERY round-tripped `private` prompt would have
        // come back `org`-visible. My own fix would have created a fresh instance of
        // the class it closes.
        //
        // The owner fix (D3a) is what actually closes `PLC-7`: with `createdBy` in the
        // id space reads compare against, an imported `private` entry is readable by
        // its importer instead of by nobody. Preserving the bundle's stated visibility
        // — and defaulting to the conservative `private` when a foreign bundle names
        // none — is therefore both sufficient and safe.
        visibility: VALID_PROMPT_VISIBILITY.has(str(item.payload.visibility)) ? str(item.payload.visibility) : 'private',
        ...(str(item.payload.description) ? { description: str(item.payload.description) } : {}),
        ...(Array.isArray(item.payload.tags) ? { tags: strArr(item.payload.tags) } : {}),
      });
      return { status: 'imported', message: `prompt '${name}' created in org ${orgId}` };
    },
  },

  'connection-ref': {
    async exportItems(tenantId) {
      // Workspace/org-scoped connections only (listConnections without a userId
      // excludes user-scoped rows) — deliberate: user connections are PERSONAL
      // consent grants; a tenant-level export must not enumerate them.
      return (await listConnections(tenantId)).map((c) => ({
        kind: 'connection-ref' as const,
        ref: `conn:${c.connectionId}`,
        // REFS ONLY (export-bundle-no-credential-material): the provider + an
        // opaque redacted ref — the target host re-binds by re-authenticating.
        payload: {
          provider: c.provider,
          kind: c.kind,
          credentialRef: `[REDACTED:${c.connectionId}]`,
          scope: c.userId ? 'user' : c.orgId ? 'org' : 'workspace',
        },
      }));
    },
    async importItem(_tenantId, _actor, item) {
      // The credential is never in the bundle, and connections have no
      // disconnected/pending state to materialize into — record-only, honest:
      // the operator re-authenticates the provider on the target host.
      return { status: 'skipped', message: `connection '${str(item.payload.provider) || item.ref}' needs re-auth on this host (bundles are refs-only)` };
    },
  },

  schedule: {
    async exportItems(tenantId, caller) {
      // ADR 0608 R2 (`CPC-13`) — the export bundle is a READ door on the same
      // `ScheduledJob` rows as `GET /scheduler/jobs`, so it must apply the SAME
      // subject gate that door does (`routes/scheduler.ts` jobGateFor). A job
      // owned by a membership-scoped subject (today a `kind:'project'` /
      // `visibility:'private'` job) that `caller` cannot READ is DROPPED here —
      // otherwise the rows the D1 scheduler fix hides re-leak through this bundle
      // to any co-tenant. A job with no such owner (`scheduleSubject` → null:
      // agent-/user-/tenant-owned, ADR 0025) is unchanged — the caller reached
      // this export through their own tenant, which is the legacy READ grant.
      const jobs = await listJobs(tenantId);
      const visible: typeof jobs = [];
      for (const j of jobs) {
        const subject = scheduleSubject(j);
        if (subject) {
          const level = await resolveSubjectAccess(tenantId, subject, caller ?? undefined);
          if (level !== null && !levelSatisfies(level, 'read')) continue; // drop-unreadable
        }
        visible.push(j);
      }
      return visible.map((j) => ({
        kind: 'schedule' as const,
        ref: `sched:${j.jobId}`,
        payload: {
          jobId: j.jobId,
          cronExpr: j.cronExpr,
          ...(j.workflowId ? { workflowId: j.workflowId } : {}),
          ...(j.timezone ? { timezone: j.timezone } : {}),
          enabled: j.enabled,
        },
      }));
    },
    async importItem(tenantId, _actor, item) {
      const cronExpr = str(item.payload.cronExpr);
      if (!cronExpr) return { status: 'skipped', message: 'payload.cronExpr missing' };
      // Deterministic id from (TENANT, bundle ref) → re-import skips, never
      // duplicates — and two tenants importing the same bundle never collide in
      // the global jobId space (getJob is not tenant-scoped; an unqualified id
      // would leak cross-tenant existence and wrongly skip).
      const jobId = `import:${encodeURIComponent(tenantId)}:${item.ref.replace(/[^a-zA-Z0-9:_-]/g, '_')}`;
      const existing = await getJob(jobId);
      if (existing && existing.tenantId === tenantId) return { status: 'skipped', message: `schedule ${jobId} already imported` };
      if (!(await claimImport(tenantId, 'schedule', jobId))) {
        return { status: 'skipped', message: `schedule ${jobId} claimed by a concurrent import` };
      }
      const out = await registerJob({
        jobId,
        tenantId,
        cronExpr,
        ...(str(item.payload.workflowId) ? { workflowId: str(item.payload.workflowId) } : {}),
        ...(str(item.payload.timezone) ? { timezone: str(item.payload.timezone) } : {}),
        // Inert-import posture: an imported bundle MUST NOT start firing
        // triggers on arrival — the operator reviews + enables explicitly.
        enabled: false,
      });
      if (!out.ok) return { status: 'skipped', message: out.error.message };
      return { status: 'imported', message: `schedule ${jobId} registered (disabled for review)` };
    },
  },

  'org-chart': {
    async exportItems(tenantId) {
      const chart = await getChart(tenantId);
      if (!chart) return [];
      return [{
        kind: 'org-chart' as const,
        ref: `orgchart:${tenantId}`,
        payload: { departments: chart.departments, members: chart.members },
      }];
    },
    async importItem(tenantId, _actor, item) {
      const departments = Array.isArray(item.payload.departments) ? item.payload.departments : [];
      const allMembers = Array.isArray(item.payload.members) ? (item.payload.members as Array<{ rosterId?: unknown }>) : [];
      // Member rows reference ORIGIN rosterIds; only keep ones that resolve in
      // THIS tenant (a same-tenant re-import keeps all; a cross-host import
      // keeps the structure and honestly reports the dropped members).
      const members: typeof allMembers = [];
      for (const m of allMembers) {
        const entry = typeof m.rosterId === 'string' ? await getRosterEntry(tenantId, m.rosterId) : null;
        if (entry) members.push(m);
      }
      const out = await putChart({ tenantId, departments: departments as never, members: members as never });
      if ('error' in out) return { status: 'skipped', message: out.error.message };
      const dropped = allMembers.length - members.length;
      return { status: 'imported', message: `org chart imported${dropped > 0 ? ` (${dropped} member(s) dropped — no matching roster entry on this host)` : ''}` };
    },
  },

  pack: {
    async exportItems() {
      // No per-tenant installed-pack enumeration seam exists yet — export an
      // honest EMPTY set rather than fabricated refs (under-export beats lies).
      return [];
    },
    async importItem(_tenantId, _actor, item) {
      return { status: 'skipped', message: `pack '${item.ref}' recorded — install packs via the registry (/v1/packs), not the bundle` };
    },
  },
};

export async function applyImport(tenantId: string, actor: string, rawBundle: unknown): Promise<ImportResult> {
  const { bundle, order } = validateForImport(rawBundle);
  const byRef = new Map(bundle.items.map((i) => [i.ref, i]));
  const items: ImportItemResult[] = [];
  let imported = 0;
  // Materialize in dependency (topo) order; one failed item never aborts the rest.
  for (const ref of order) {
    const item = byRef.get(ref);
    if (!item) continue;
    try {
      const out = await KIND_HANDLERS[item.kind].importItem(tenantId, actor, item);
      if (out.status === 'imported') imported += 1;
      items.push({ ref, kind: item.kind, status: out.status, ...(out.message ? { message: out.message } : {}) });
    } catch (err) {
      items.push({ ref, kind: item.kind, status: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { dryRun: false, imported, refs: order, items };
}

/** Build a refs-only export bundle from the tenant's REAL entities. `caller` is
 *  the acting subject (or null for a system/unauthenticated export); it gates the
 *  membership-scoped slices (today `schedule`, ADR 0608 R2 `CPC-13`). The other
 *  kinds are still authorized only by tenant co-residency — the broad `/export`
 *  authz gap is tracked separately (`CPC-16`). */
export async function buildExportBundle(tenant: string, kinds?: string[], caller?: string | null): Promise<ExportBundle> {
  const wanted: readonly ExportKind[] = kinds && kinds.length
    ? EXPORT_KINDS.filter((k) => kinds.includes(k))
    : EXPORT_KINDS;
  const items: ExportItem[] = [];
  for (const kind of wanted) {
    items.push(...(await KIND_HANDLERS[kind].exportItems(tenant, caller ?? null)));
  }
  const bundle: ExportBundle = {
    bundleVersion: '1',
    source: { origin: `host:openwop-app:${tenant}`, exportedAt: new Date().toISOString() },
    items,
  };
  // Self-check the refs-only invariant on our OWN export — a leaky export must
  // never leave the host (export-bundle-no-credential-material, both directions).
  for (const item of bundle.items) {
    const hit = findLiteralCredential(item.payload, `${item.kind}:${item.ref}.payload`);
    if (hit) throw new CredentialMaterialError(hit);
  }
  return bundle;
}
