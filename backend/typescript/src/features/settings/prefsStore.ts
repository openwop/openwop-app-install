/**
 * Per-user server-authoritative settings (ADR 0396 §4) — the KV-blob pattern
 * (ADR 0383): a durable row per (tenant, user) in `host_ext_kv`, no SQL
 * migration. Holds ONLY enforcement-bearing prefs (personal budget cap,
 * reasoning-directive override, privacy opt-outs) — cosmetic prefs stay
 * localStorage (the ThemeToggle/a11yPrefs tier).
 *
 * Every read/write is keyed by the AUTHENTICATED user's own id — never a
 * request-supplied id (IDOR-safe by construction, matrix row 8).
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import type { ReasoningDirectiveStrength } from '../../host/envelopeDirective.js';
import type { SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';

export interface PersonalBudgetPref {
  /** Daily BYOK token cap (0 ⇒ no personal cap). Tokens, never USD (the ADR
   *  0178/0106 staleness ruling). Can only LOWER the org cap (min()). */
  dailyTokenCap: number;
  /** Soft-warning threshold percent (default 80). */
  softWarningPct?: number;
}

export interface PrivacyPrefs {
  analyticsOptOut?: boolean;
  crashReportsOptOut?: boolean;
  recentFilesOptOut?: boolean;
}

export interface UserPrefs {
  id: string; // `${tenantId}:${userId}`
  tenantId: string;
  userId: string;
  personalBudget?: PersonalBudgetPref;
  /** Per-user RFC 0030 reasoning-directive override ('off'|'advisory'|'mandatory');
   *  absent ⇒ the host-wide posture. Strength only — no confidence threshold
   *  exists to expose (ADR 0396 OQ-4, honestly omitted). */
  reasoningDirective?: ReasoningDirectiveStrength;
  privacy?: PrivacyPrefs;
  updatedAt: string;
}

const rows = new DurableCollection<UserPrefs>(
  'settings:user-prefs',
  (r) => r.id,
  undefined,
  (r) => r.tenantId,
);

const key = (tenantId: string, userId: string): string => `${tenantId}:${userId}`;

export async function getUserPrefs(tenantId: string, userId: string): Promise<UserPrefs | null> {
  return rows.get(key(tenantId, userId));
}

export async function putUserPrefs(
  tenantId: string,
  userId: string,
  input: { personalBudget?: PersonalBudgetPref | null; reasoningDirective?: ReasoningDirectiveStrength | null; privacy?: PrivacyPrefs | null },
): Promise<UserPrefs> {
  // GRADE-DATA 2026-07-17 — CAS-retry, not read-merge-put: two tabs saving
  // different pref GROUPS concurrently must both keep their fields.
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await rows.get(key(tenantId, userId));
    const next: UserPrefs = {
      id: key(tenantId, userId),
      tenantId,
      userId,
      // A field passed as null clears it; undefined keeps the stored value.
      ...(input.personalBudget === null ? {} : input.personalBudget !== undefined ? { personalBudget: input.personalBudget } : existing?.personalBudget ? { personalBudget: existing.personalBudget } : {}),
      ...(input.reasoningDirective === null ? {} : input.reasoningDirective !== undefined ? { reasoningDirective: input.reasoningDirective } : existing?.reasoningDirective ? { reasoningDirective: existing.reasoningDirective } : {}),
      ...(input.privacy === null ? {} : input.privacy !== undefined ? { privacy: input.privacy } : existing?.privacy ? { privacy: existing.privacy } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (await rows.compareAndSwap(existing ?? null, next)) return next;
  }
  throw new Error('settings prefs write lost the CAS race 5 times');
}

// ── Per-user BYOK usage counters (the personal accounting lane) ─────────────
// Keyed (tenant, user, UTC-day); CAS-retry increment (the lineage precedent) so
// concurrent turns both count.

interface UserUsageRow {
  id: string; // `${tenantId}:${userId}:${day}`
  tenantId: string;
  /** CHAN-F19 #4 — the counter's person, also in the key. Rows written before
   *  this field existed lack it; the eraser reads those from the key. */
  userId?: string;
  inputTokens: number;
  outputTokens: number;
  updatedAt: string;
}
const usage = new DurableCollection<UserUsageRow>(
  'settings:byok-usage',
  (r) => r.id,
  undefined,
  (r) => r.tenantId,
);
// GRADE-DATA 2026-07-17 — per-(user,day) rows mint forever but only "today" is
// ever read; age them out after 90 days (the kvAgeOut retention daemon).
// `acceptIndexed` (review F3): this collection IS tenant-indexed — the sweep
// deletes via the collection so its `hostextidx:` markers clean up with the
// rows (WF-ORGINV-1 marker-aware sweep); index markers would strand if deletes
// ever bypassed the collection again.
registerKvAgeOut({ id: 'settings:byok-usage', prefix: 'hostext:settings:byok-usage:', ttlDays: 90, timestampField: 'updatedAt', acceptIndexed: true });
const usageKey = (tenantId: string, userId: string, day: string): string => `${tenantId}:${userId}:${day}`;

export async function getUserByokUsage(tenantId: string, userId: string, day: string): Promise<{ inputTokens: number; outputTokens: number }> {
  const row = await usage.get(usageKey(tenantId, userId, day));
  return { inputTokens: row?.inputTokens ?? 0, outputTokens: row?.outputTokens ?? 0 };
}

export async function incrementUserByokUsage(tenantId: string, userId: string, day: string, inputTokens: number, outputTokens: number): Promise<void> {
  const k = usageKey(tenantId, userId, day);
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await usage.get(k);
    const next: UserUsageRow = {
      id: k,
      tenantId,
      userId,
      inputTokens: (cur?.inputTokens ?? 0) + inputTokens,
      outputTokens: (cur?.outputTokens ?? 0) + outputTokens,
      updatedAt: new Date().toISOString(),
    };
    if (await usage.compareAndSwap(cur ?? null, next)) return;
  }
  // A persistent CAS loser under-counts one turn — acceptable for a personal
  // soft budget; the org lane (ADR 0178) still counts it authoritatively.
}

/** The user a usage row counts: its `userId`, or (rows written before that
 *  field) the middle of its key, which is `${tenantId}:${userId}:${day}`. A user
 *  id may contain ':' and a day never does, so the key is cut at its last ':'. */
function usageRowUser(tenantId: string, r: UserUsageRow): string | null {
  if (r.userId) return r.userId;
  const prefix = `${tenantId}:`;
  const end = r.id.lastIndexOf(':');
  return r.id.startsWith(prefix) && end > prefix.length ? r.id.slice(prefix.length, end) : null;
}

/**
 * CHAN-F19 #4 (ADR 0464 §9) — a person's settings: their prefs row and their
 * per-day BYOK usage counters. Both are deleted, not scrubbed: every row in
 * these two stores is keyed to one person, so neither holds a shared or
 * tenant-level setting. A personal pref means nothing without its person, and
 * the counters are personal accounting (the org lane, ADR 0178, keeps its own
 * count). Tenant-scoped only: a user id is never matched in another tenant.
 */
export async function eraseSettingsSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 }; // never an unscoped sweep
  const { forms } = subjectKeyForms(subjectKey);
  let rowsTouched = 0;
  for (const userId of forms) if (await rows.delete(key(tenantId, userId))) rowsTouched++;
  for (const r of await usage.listForTenantIndexed(tenantId)) {
    if (r.tenantId !== tenantId) continue;
    const user = usageRowUser(tenantId, r);
    if (user !== null && forms.has(user) && await usage.delete(r.id)) rowsTouched++;
  }
  return { rowsTouched };
}

/** Test-only. */
export async function __resetSettingsStores(): Promise<void> {
  await rows.__clear();
  await usage.__clear();
}
