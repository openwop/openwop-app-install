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
