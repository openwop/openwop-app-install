/**
 * Central browser-storage policy for the app.
 *
 * Before this module, localStorage/sessionStorage keys, quota handling, and
 * redaction expectations were scattered across ~20 call sites. This is the
 * single source of truth for:
 *   - the key registry (STORAGE_KEYS) + their data classification,
 *   - quota-/privacy-safe get/set wrappers that never throw into callers,
 *   - the rule that PII/secret material is never persisted to the browser.
 *
 * Data-classification policy (see STORAGE.md for the per-key table):
 *   - `secret`   — MUST NOT be stored in the browser at all. The BYOK
 *                  credential VALUE lives only in the BE secret resolver; the
 *                  browser keeps the credentialRef NAME (class `ref`) only.
 *   - `ref`      — opaque server-side reference names (e.g. credentialRef).
 *   - `pref`     — UI preferences (theme, panel open state, density).
 *   - `content`  — user-authored content cached for offline/cold-start
 *                  resilience (chat sessions, prompts, draft workflows).
 *   - `diag`     — developer diagnostics (network recorder). Tab-scoped
 *                  (sessionStorage) and credential-redacted; prod-default-off.
 *
 * Retention: `pref`/`ref` persist indefinitely (localStorage); `content`
 * persists until the user clears it; `diag` is sessionStorage (tab lifetime).
 */

export type StorageArea = 'local' | 'session';
export type DataClass = 'ref' | 'pref' | 'content' | 'diag';

export interface StorageKeySpec {
  readonly key: string;
  readonly area: StorageArea;
  readonly cls: DataClass;
  /** Human note for STORAGE.md / audits. */
  readonly note: string;
}

/**
 * Registry of static storage keys. Dynamic, per-tenant keys are built from
 * these prefixes by their owning modules (e.g. the chat left-rail tab key is
 * suffixed with the tenant id). NOTE: no entry is class `secret` — that is the
 * invariant. Adding a secret here is a policy violation, not a new feature.
 */
export const STORAGE_KEYS = {
  theme: { key: 'openwop.theme', area: 'local', cls: 'pref', note: 'forced light/dark/system override' },
  sidebarCollapsed: { key: 'openwop.sidebar.collapsed', area: 'local', cls: 'pref', note: 'nav rail collapsed' },
  adminRailCollapsed: { key: 'openwop.admin.railCollapsed', area: 'local', cls: 'pref', note: 'admin rail collapsed' },
  runsDensity: { key: 'openwop.runs.density', area: 'local', cls: 'pref', note: 'runs table density' },
  demoBannerDismissed: { key: 'openwop:demo-banner:dismissed', area: 'local', cls: 'pref', note: 'demo banner dismissed' },
  notificationPrefs: { key: 'openwop:notification-prefs:v1', area: 'local', cls: 'pref', note: 'notification preferences' },
  appGateUnlocked: { key: 'openwop.appGate.unlocked', area: 'local', cls: 'pref', note: 'demo gate unlocked flag' },
  thoughtsAnim: { key: 'openwop-thoughts-anim', area: 'local', cls: 'pref', note: 'reasoning animation pref' },

  byokActiveConfig: { key: 'openwop-app.byok.activeConfig', area: 'local', cls: 'ref', note: 'provider/model/credentialRef NAME only — never the key value' },
  byokPendingManaged: { key: 'openwop-app.byok.pendingManaged', area: 'local', cls: 'ref', note: 'pending managed-provider id' },

  chatSession: { key: 'openwop-app.chat.session', area: 'local', cls: 'content', note: 'current chat thread (cold-start cache)' },
  chatSessionsIndex: { key: 'openwop-app.chat.sessions-index', area: 'local', cls: 'content', note: 'session header index for History drawer' },
  promptsUser: { key: 'openwop-app.prompts.user', area: 'local', cls: 'content', note: 'user-authored prompts' },
  builderWorkflows: { key: 'openwop-app.builder.workflows', area: 'local', cls: 'content', note: 'draft workflows' },

  networkRecorder: { key: 'openwop.networkRecorder.v1', area: 'session', cls: 'diag', note: 'credential-redacted traffic mirror; tab-scoped; prod-default-off' },
  lastSuccessAt: { key: 'openwop-app.lastSuccessAt', area: 'local', cls: 'diag', note: 'cold-start warm-window hint (timestamp)' },
} as const satisfies Record<string, StorageKeySpec>;

export type StorageKeyName = keyof typeof STORAGE_KEYS;

/**
 * One-time localStorage namespace migration: `openwop.sample.*` → `openwop-app.*`.
 *
 * The legacy `openwop.sample.` prefix was renamed during white-label
 * productionization. This re-homes any pre-existing keys (static registry keys
 * AND dynamic per-tenant keys like chat panel state / builder migration flags)
 * so returning users keep their chat sessions, prompts, and draft workflows.
 * Idempotent and never throws; safe to call on every boot. Call once at startup.
 */
const LEGACY_NS = 'openwop.sample.';
const NEW_NS = 'openwop-app.';
export function migrateSampleNamespace(): void {
  if (typeof window === 'undefined') return;
  let store: Storage;
  try {
    store = window.localStorage;
  } catch {
    return; // privacy mode
  }
  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(LEGACY_NS)) legacyKeys.push(k);
    }
    for (const oldKey of legacyKeys) {
      const newKey = NEW_NS + oldKey.slice(LEGACY_NS.length);
      try {
        const val = store.getItem(oldKey);
        if (val !== null && store.getItem(newKey) === null) store.setItem(newKey, val);
        store.removeItem(oldKey);
      } catch {
        /* quota/privacy — skip this key */
      }
    }
  } catch {
    /* ignore — migration is best-effort */
  }
}

function area(a: StorageArea): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return a === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null; // access can throw under strict privacy settings
  }
}

/** Quota-/privacy-safe read. Returns null on any failure. */
export function readRaw(spec: StorageKeySpec): string | null {
  const store = area(spec.area);
  if (!store) return null;
  try {
    return store.getItem(spec.key);
  } catch {
    return null;
  }
}

/** Quota-/privacy-safe write. Returns false (never throws) on failure. */
export function writeRaw(spec: StorageKeySpec, value: string): boolean {
  const store = area(spec.area);
  if (!store) return false;
  try {
    store.setItem(spec.key, value);
    return true;
  } catch {
    return false; // QuotaExceededError / privacy mode
  }
}

export function removeRaw(spec: StorageKeySpec): void {
  const store = area(spec.area);
  if (!store) return;
  try {
    store.removeItem(spec.key);
  } catch {
    /* ignore */
  }
}

/** Typed JSON read with a validator guard. Returns fallback on miss/parse/guard failure. */
export function readJson<T>(spec: StorageKeySpec, guard: (v: unknown) => v is T, fallback: T): T {
  const raw = readRaw(spec);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Typed JSON write. Returns false on quota/serialization failure. */
export function writeJson(spec: StorageKeySpec, value: unknown): boolean {
  try {
    return writeRaw(spec, JSON.stringify(value));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject-scoped `content` keys (ADR 0434 Phase 3)
//
// The four class-`content` keys above held user-authored work under a BARE key,
// so the content was per-device by construction and, on a shared machine, the
// next person to use the browser saw the previous user's chat threads, prompts,
// and draft workflows.
//
// The scheme — deliberately the SIMPLEST one that works:
//   signed in  → `<key>:<uid>`
//   anonymous  → `<key>`  (the bare key IS the anonymous key)
//
// Two consequences make this the right call rather than merely the easiest:
//   1. NO migration is required. Every payload sitting at a bare key today is
//      already correctly placed as anonymous content, and a visitor who never
//      signs in keeps it exactly where it is.
//   2. It mirrors the backend, where the anon sandbox is the default that gets
//      ADOPTED into the user tenant on sign-in (ADR 0003 Phase 4c). Local
//      adoption below is the client-side half of the same idea.
//
// A per-device generated id was REJECTED: it would introduce a third identity
// concept with no owner, beside the Firebase uid and the backend session.
// ─────────────────────────────────────────────────────────────────────────────

/** The storage key for `spec` scoped to `subject` (null/undefined ⇒ anonymous,
 *  which is the bare key). */
export function scopedKey(spec: StorageKeySpec, subject: string | null | undefined): string {
  return subject ? `${spec.key}:${subject}` : spec.key;
}

/** A subject-scoped spec, usable with the readRaw/writeRaw/readJson helpers. */
export function scopedSpec(spec: StorageKeySpec, subject: string | null | undefined): StorageKeySpec {
  return { ...spec, key: scopedKey(spec, subject) };
}

/** Versioned envelope for subject-scoped content. The `subject` field is
 *  redundant with the key suffix ON PURPOSE — belt and braces, mirroring
 *  `sanitizeTabDeck`, so a payload that somehow lands under the wrong key is
 *  still refused on read rather than shown to the wrong person. */
export interface ScopedEnvelope<T> {
  v: number;
  subject: string | null;
  data: T;
}

/**
 * Read subject-scoped content. Returns `fallback` when absent, corrupt, of a
 * different version, or — critically — stamped with a DIFFERENT subject.
 * Module-internal: callers reach it through `adoptAnonScoped`, or read via
 * their own shape guard (the four content modules have different shapes).
 */
function readScoped<T>(
  spec: StorageKeySpec,
  subject: string | null | undefined,
  version: number,
  guard: (v: unknown) => v is T,
  fallback: T,
): T {
  const raw = readRaw(scopedSpec(spec, subject));
  if (raw === null) return fallback;
  try {
    const env = JSON.parse(raw) as Partial<ScopedEnvelope<unknown>>;
    if (env.v !== version) return fallback;
    // Never surface another subject's content, even if the key matched.
    if ((env.subject ?? null) !== (subject ?? null)) return fallback;
    return guard(env.data) ? env.data : fallback;
  } catch {
    return fallback;
  }
}

/** Write subject-scoped content. Returns false on quota/serialization failure —
 *  callers that are merging MUST check it, or a quota failure silently loses
 *  the merged result. */
export function writeScoped<T>(
  spec: StorageKeySpec,
  subject: string | null | undefined,
  version: number,
  data: T,
): boolean {
  const env: ScopedEnvelope<T> = { v: version, subject: subject ?? null, data };
  try {
    return writeRaw(scopedSpec(spec, subject), JSON.stringify(env));
  } catch {
    return false;
  }
}

/**
 * Adopt anonymous content into a freshly signed-in subject's scope — the
 * client-side mirror of the backend's anon-sandbox adoption.
 *
 * `merge(anon, user)` decides the result; each caller supplies it because the
 * shapes differ (a keyed workflow map genuinely merges; a single current chat
 * thread cannot). The invariant every caller must honor: **union, never
 * destroy, and prefer the signed-in copy on a true collision.**
 *
 * Idempotent: the anonymous payload is removed only after the merged write is
 * CONFIRMED, so a quota failure leaves the source intact for a later retry
 * rather than dropping the user's work on the floor.
 */
export function adoptAnonScoped<T>(
  spec: StorageKeySpec,
  subject: string,
  version: number,
  guard: (v: unknown) => v is T,
  merge: (anon: T, user: T | null) => T,
): boolean {
  const anonRaw = readRaw(spec); // the bare key — anonymous content
  if (anonRaw === null) return false;

  // The anon payload predates this scheme (no envelope) OR was written under
  // it; accept both so content authored before Phase 3 still follows the user.
  let anonData: unknown;
  try {
    const parsed: unknown = JSON.parse(anonRaw);
    const asEnv = parsed as Partial<ScopedEnvelope<unknown>>;
    anonData = asEnv && typeof asEnv === 'object' && 'v' in asEnv && 'data' in asEnv ? asEnv.data : parsed;
  } catch {
    return false;
  }
  if (!guard(anonData)) return false;

  const existing = readScoped<T | null>(spec, subject, version, (v): v is T | null => guard(v), null);
  const merged = merge(anonData, existing);
  if (!writeScoped(spec, subject, version, merged)) return false; // quota — keep the source
  removeRaw(spec);
  return true;
}

/**
 * The subject whose `content` keys this browser tab is currently reading and
 * writing. `null` = anonymous (the bare key).
 *
 * Module-level rather than threaded through every call site: `localStore`,
 * `userPrompts`, and the chat caches are plain modules invoked from dozens of
 * places, and passing a subject down all of them would spread identity across
 * the codebase — the opposite of the single-owner rule. ONE writer sets this
 * (the auth layer, on `onAuthChanged`); every content module reads it. A
 * module-level singleton is the right shape here (Firebase's own `auth` is one);
 * it is made OBSERVABLE below so React consumers re-render on change, per the
 * `useSyncExternalStore` contract.
 *
 * ADR 0434 / IDN-3 — `resolved` distinguishes "auth has not settled yet" from
 * "settled, anonymous". Before this, reads during the boot window returned
 * `null` and were INDISTINGUISHABLE from a real anonymous session, so a
 * returning signed-in user briefly read the anonymous key. That conflation was
 * the defect; `authStateReady()` / the first `onAuthChanged` is what resolves
 * it. `getStorageSubject()` still returns the bare `string | null` (a pending
 * read yields `null` = the anonymous key, which is safe — an anonymous read can
 * never expose another user's content), but React consumers can now gate on
 * `resolved` and render a skeleton instead of empty content.
 */
let currentSubject: string | null = null;
let subjectResolved = false;

const subjectListeners = new Set<() => void>();

export function setStorageSubject(subject: string | null): void {
  const changed = currentSubject !== subject || !subjectResolved;
  currentSubject = subject;
  subjectResolved = true;
  if (changed) for (const fn of subjectListeners) fn();
}

export function getStorageSubject(): string | null {
  return currentSubject;
}

/** True once the auth layer has settled the initial state (signed-in OR
 *  anonymous). False only during the boot window. */
export function isStorageSubjectResolved(): boolean {
  return subjectResolved;
}

/** Subscribe to subject changes (the `useSyncExternalStore` contract). Returns
 *  an unsubscribe. */
export function subscribeStorageSubject(listener: () => void): () => void {
  subjectListeners.add(listener);
  return () => { subjectListeners.delete(listener); };
}

/** Snapshot for `useSyncExternalStore`. A primitive so the default `Object.is`
 *  comparison is correct: `<subject>` when resolved, the `'\0pending'` sentinel
 *  while the boot window is open (an impossible real subject, so it never
 *  collides with an anonymous `null` rendered as its own state). */
export function storageSubjectSnapshot(): string | null {
  return subjectResolved ? currentSubject : PENDING_SUBJECT;
}

/** Sentinel snapshot value for the unresolved boot window. Exported so the React
 *  hook can map it to a `pending` status without re-deriving the rule. */
export const PENDING_SUBJECT = '\0pending';

/** For tests — reset the module singleton so parallel suites don't bleed
 *  (ADR 0434 / IDN-4). Not for production paths. */
export function __resetStorageSubjectForTest(): void {
  currentSubject = null;
  subjectResolved = false;
  subjectListeners.clear();
}
