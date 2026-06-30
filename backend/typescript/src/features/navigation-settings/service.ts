/**
 * ADR 0139 — navigation-settings store + validation.
 *
 * Two layers persisted in ONE `DurableCollection`, keyed so lookups are point
 * `get(id)`s (never a `list()` scan): the tenant default (`${tenantId}:tenant`)
 * and each user's personalization (`${tenantId}:user:${userId}`). Tenant
 * isolation is structural — every key embeds the caller's tenantId. Writes are
 * last-writer-wins (a layer is one whole document; no concurrent-merge invariant).
 *
 * `validateMenuConfig` fails closed on malformed/oversized input (400) so a bad
 * client can neither corrupt the store nor blow it up.
 *
 * @see docs/adr/0139-configurable-navigation-menu.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import {
  EMPTY_MENU_CONFIG,
  type HeaderDef,
  type ItemOverride,
  type MenuConfig,
  type MenuConfigBundle,
  type MenuTier,
  type StoredMenuConfig,
} from './types.js';

const store = new DurableCollection<StoredMenuConfig>('navigation-settings:config', (s) => s.id);

// Defensive caps — a menu config is small by nature; these bound abuse/DoS.
const MAX_ITEMS = 500;
const MAX_HEADERS = 100;
const MAX_KEY = 200;
const MAX_LABEL = 120;
const MAX_ORDER = 100_000;
const TIERS: ReadonlySet<string> = new Set<MenuTier>(['workspace', 'admin']);

const tenantKey = (tenantId: string): string => `${tenantId}:tenant`;
const userKey = (tenantId: string, userId: string): string => `${tenantId}:user:${userId}`;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateTier(v: unknown, field: string): MenuTier | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !TIERS.has(v)) {
    throw new OpenwopError('validation_error', `\`${field}\` must be "workspace" or "admin".`, 400, { field });
  }
  return v as MenuTier;
}

function validateOrder(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_ORDER) {
    throw new OpenwopError('validation_error', `\`${field}\` must be a finite number within ±${MAX_ORDER}.`, 400, { field });
  }
  return v;
}

function validateLabel(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new OpenwopError('validation_error', `\`${field}\` must be a string.`, 400, { field });
  }
  const t = v.trim();
  return t.length === 0 ? undefined : t.slice(0, MAX_LABEL);
}

function validateBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    throw new OpenwopError('validation_error', `\`${field}\` must be a boolean.`, 400, { field });
  }
  return v;
}

function validateKey(v: string, field: string): string {
  if (v.length === 0 || v.length > MAX_KEY) {
    throw new OpenwopError('validation_error', `\`${field}\` must be 1–${MAX_KEY} chars.`, 400, { field });
  }
  return v;
}

/** Validate + normalize untrusted input into a `MenuConfig`. Drops undefined
 *  fields (so the stored doc is minimal and `exactOptionalPropertyTypes`-clean). */
export function validateMenuConfig(raw: unknown): MenuConfig {
  if (raw === undefined || raw === null) return { items: {}, headers: [] };
  if (!isPlainObject(raw)) {
    throw new OpenwopError('validation_error', '`config` must be an object.', 400, { field: 'config' });
  }

  const rawItems = raw.items ?? {};
  if (!isPlainObject(rawItems)) {
    throw new OpenwopError('validation_error', '`config.items` must be an object.', 400, { field: 'config.items' });
  }
  const itemEntries = Object.entries(rawItems);
  if (itemEntries.length > MAX_ITEMS) {
    throw new OpenwopError('validation_error', `Too many item overrides (max ${MAX_ITEMS}).`, 400, { field: 'config.items' });
  }
  const items: Record<string, ItemOverride> = {};
  for (const [path, rawOv] of itemEntries) {
    validateKey(path, `config.items["${path}"]`);
    if (!isPlainObject(rawOv)) {
      throw new OpenwopError('validation_error', `\`config.items["${path}"]\` must be an object.`, 400, { field: path });
    }
    const tier = validateTier(rawOv.tier, `items["${path}"].tier`);
    const group = rawOv.group === undefined ? undefined : validateKey(String(rawOv.group), `items["${path}"].group`);
    const order = validateOrder(rawOv.order, `items["${path}"].order`);
    const hidden = validateBool(rawOv.hidden, `items["${path}"].hidden`);
    const ov: ItemOverride = {};
    if (tier !== undefined) ov.tier = tier;
    if (group !== undefined) ov.group = group;
    if (order !== undefined) ov.order = order;
    if (hidden !== undefined) ov.hidden = hidden;
    items[path] = ov;
  }

  const rawHeaders = raw.headers ?? [];
  if (!Array.isArray(rawHeaders)) {
    throw new OpenwopError('validation_error', '`config.headers` must be an array.', 400, { field: 'config.headers' });
  }
  if (rawHeaders.length > MAX_HEADERS) {
    throw new OpenwopError('validation_error', `Too many headers (max ${MAX_HEADERS}).`, 400, { field: 'config.headers' });
  }
  const headers: HeaderDef[] = [];
  const seenIds = new Set<string>();
  for (const rawH of rawHeaders) {
    if (!isPlainObject(rawH)) {
      throw new OpenwopError('validation_error', '`config.headers[]` entries must be objects.', 400, { field: 'config.headers' });
    }
    if (typeof rawH.id !== 'string') {
      throw new OpenwopError('validation_error', '`config.headers[].id` is required.', 400, { field: 'headers[].id' });
    }
    const id = validateKey(rawH.id, 'headers[].id');
    if (seenIds.has(id)) {
      throw new OpenwopError('validation_error', `Duplicate header id "${id}".`, 400, { field: 'headers[].id' });
    }
    seenIds.add(id);
    const tier = validateTier(rawH.tier, `headers["${id}"].tier`);
    if (tier === undefined) {
      throw new OpenwopError('validation_error', `\`headers["${id}"].tier\` is required.`, 400, { field: 'headers[].tier' });
    }
    const label = validateLabel(rawH.label, `headers["${id}"].label`);
    const order = validateOrder(rawH.order, `headers["${id}"].order`);
    const custom = validateBool(rawH.custom, `headers["${id}"].custom`);
    const h: HeaderDef = { id, tier };
    if (label !== undefined) h.label = label;
    if (order !== undefined) h.order = order;
    if (custom !== undefined) h.custom = custom;
    headers.push(h);
  }

  return { items, headers };
}

async function read(id: string): Promise<MenuConfig> {
  const row = await store.get(id);
  return row?.config ?? EMPTY_MENU_CONFIG;
}

/** The current tenant-layer version tag (its `updatedAt`, or '' when unset) — the
 *  ETag a caller round-trips via `If-Match` for optimistic concurrency (CHN-6). */
export async function tenantConfigVersion(tenantId: string): Promise<string> {
  return (await store.get(tenantKey(tenantId)))?.updatedAt ?? '';
}

/** The combined bundle the FE provider fetches on load (one round-trip). */
export async function getBundle(tenantId: string, userId: string): Promise<MenuConfigBundle> {
  const [tenant, user] = await Promise.all([read(tenantKey(tenantId)), read(userKey(tenantId, userId))]);
  return { tenant, user };
}

/** The tenant layer only (a superadmin bearer with no user identity) — the user
 *  layer is reported empty. */
export async function getTenantBundle(tenantId: string): Promise<MenuConfigBundle> {
  return { tenant: await read(tenantKey(tenantId)), user: EMPTY_MENU_CONFIG };
}

/** Persist the tenant menu layer. With `expectedVersion` supplied (CHN-6) the write is
 *  guarded by optimistic concurrency: a stale `If-Match` or a racing concurrent write is
 *  rejected `409 conflict` rather than silently clobbering the other superadmin's edit.
 *  Omitting `expectedVersion` preserves the legacy last-writer-wins behaviour. Returns
 *  the new version tag. */
export async function putTenantConfig(tenantId: string, updatedBy: string, config: MenuConfig, expectedVersion?: string): Promise<string> {
  const id = tenantKey(tenantId);
  const updatedAt = new Date().toISOString();
  const next: StoredMenuConfig = { id, tenantId, scope: 'tenant', config, updatedAt, updatedBy };
  if (expectedVersion === undefined) {
    await store.put(next);
    return updatedAt;
  }
  const current = await store.get(id);
  if ((current?.updatedAt ?? '') !== expectedVersion) {
    throw new OpenwopError('conflict', 'The menu configuration changed since you loaded it; reload and re-apply.', 409, { expectedVersion });
  }
  const swapped = await store.compareAndSwap(current ?? null, next);
  if (!swapped) {
    throw new OpenwopError('conflict', 'The menu configuration changed since you loaded it; reload and re-apply.', 409, { expectedVersion });
  }
  return updatedAt;
}

export async function putUserConfig(tenantId: string, userId: string, config: MenuConfig): Promise<void> {
  await store.put({ id: userKey(tenantId, userId), tenantId, scope: 'user', subject: userId, config, updatedAt: new Date().toISOString(), updatedBy: userId });
}
