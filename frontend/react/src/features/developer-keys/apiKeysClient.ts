/**
 * ADR 0800 D2 — the ONE client for the ADR 0270 developer-key routes
 * (`/host/openwop-app/developer-keys`), shared by the "API keys" Access Hub tab
 * and the "AI clients (MCP)" tab (which names its keys `MCP: <label>` and lists
 * only those).
 *
 * The server narrows an `owk_` key to the scopes it DECLARES, by exact
 * inclusion (`keyDeclarationPermits`). So a preset is not a label: a key
 * without `runs:read` creates a run and is then refused reading it. The presets
 * below are pinned to the backend's scope registry by
 * `backend/typescript/test/api-keys-preset-parity.test.ts`.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { ApiError } from '../../client/requestJson.js';

export interface DeveloperKey {
  keyId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  /** `owk_XXXX…YYYY` — enough to match a found key to its row (ADR 0798). */
  hint?: string;
  lastUsedIp?: string;
  lastUsedAgent?: string;
  /** Rotation (ADR 0798): the key that replaced this one / that this one replaced. */
  rotatedTo?: string;
  rotatedFrom?: string;
  /** Issued by the caller (an admin's list also holds colleagues' keys). */
  mine?: boolean;
}

export type ApiKeyPreset = 'run' | 'read' | 'cli';

/**
 * What a person picks from, mapped to the key's declared scopes.
 *
 * `run` and `read` are deliberately PROTOCOL-ONLY: a key for a script that
 * starts runs should not be able to read the workspace's records. `cli` is the
 * one for a person at a terminal — every protocol scope plus `workspace:read`
 * and `workspace:write`, which the app's own `/host/openwop-app/*` routes
 * require of a key (ADR 0795 D2); `openwop agents list` needs it.
 */
export const API_KEY_PRESETS: Record<ApiKeyPreset, string[]> = {
  run: ['runs:create', 'runs:read', 'runs:cancel', 'artifacts:read', 'approvals:respond'],
  read: ['runs:read', 'artifacts:read'],
  cli: [
    'runs:create', 'runs:read', 'runs:cancel', 'artifacts:read', 'approvals:respond', 'webhooks:manage',
    // RFC 0233 — the connection-provider registry reads (`openwop` CLI parity).
    'manifest:read',
    'runs:annotate', 'prompts:read', 'prompts:write', 'content:read', 'content:write',
    'workspace:read', 'workspace:write',
  ],
};

/** ADR 0795 D4 — what this deployment will issue (`GET /developer-keys` → `policy`). */
export interface KeyMintPolicy {
  defaultLifetimeDays: number;
  maxLifetimeDays: number;
  allowNoExpiry: boolean;
  /** ADR 0798 — the workspace turned keys off: none can be created, none authenticates. */
  disabled?: boolean;
}
/** Used until the server answers, and against a server that predates the field. */
export const FALLBACK_KEY_POLICY: KeyMintPolicy = { defaultLifetimeDays: 90, maxLifetimeDays: 366, allowNoExpiry: false };

/** The lifetimes offered: the usual steps that fit under the cap, plus the default. */
export function lifetimeChoices(policy: KeyMintPolicy): number[] {
  const steps = [30, 90, 180, 366].filter((d) => d <= policy.maxLifetimeDays);
  return [...new Set([...steps, policy.defaultLifetimeDays])].sort((a, b) => a - b);
}

/** The name prefix the "AI clients (MCP)" tab gives the keys it mints. */
export const MCP_KEY_PREFIX = 'MCP: ';

const keysUrl = `${config.baseUrl}/host/openwop-app/developer-keys`;

/** Throws an `ApiError` carrying status + parsed envelope, never transport text,
 *  so a page can tell signed-out / forbidden / an outage apart. A 200 whose
 *  body is not JSON (a proxy's HTML fallback) is an error too. */
export async function asJson<T>(res: Response, ctx: string): Promise<T> {
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok || body === undefined) {
    const said = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
    throw new ApiError({
      status: res.ok ? 502 : res.status,
      statusText: res.statusText,
      url: ctx,
      body,
      message: typeof said === 'string' && said ? said : `${ctx} returned ${res.status}`,
    });
  }
  return body as T;
}

const json = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** Every key the caller may see that has not been revoked, and the mint policy. */
export async function listDeveloperKeysWithPolicy(): Promise<{ keys: DeveloperKey[]; policy: KeyMintPolicy }> {
  const { keys, policy } = await asJson<{ keys: DeveloperKey[]; policy?: KeyMintPolicy }>(
    await fetch(keysUrl, fetchOpts({ headers: authedHeaders() })),
    'developer keys',
  );
  return { keys: keys.filter((k) => !k.revokedAt), policy: policy ?? FALLBACK_KEY_POLICY };
}

/** Every key the caller may see that has not been revoked. */
export async function listDeveloperKeys(): Promise<DeveloperKey[]> {
  return (await listDeveloperKeysWithPolicy()).keys;
}

/**
 * `lifetimeDays`: a number of days, `null` for no expiry (only where the
 * deployment allows it), or omitted for the deployment's default.
 */
export async function createDeveloperKey(name: string, scopes: string[], lifetimeDays?: number | null): Promise<{ token: string; key: DeveloperKey }> {
  const expiresAt = lifetimeDays === undefined ? undefined
    : lifetimeDays === null ? null
    : new Date(Date.now() + lifetimeDays * 86_400_000).toISOString();
  return asJson(
    await fetch(keysUrl, fetchOpts({
      method: 'POST',
      headers: json(),
      body: JSON.stringify({ name: name.slice(0, 120), scopes, ...(expiresAt !== undefined ? { expiresAt } : {}) }),
    })),
    'developer key issue',
  );
}

/** Rotate (ADR 0798): a replacement with the same scopes; the old key keeps working for a bounded overlap. */
export async function rotateDeveloperKey(keyId: string): Promise<{ token: string; key: DeveloperKey; previous: DeveloperKey }> {
  return asJson(
    await fetch(`${keysUrl}/${encodeURIComponent(keyId)}/rotate`, fetchOpts({ method: 'POST', headers: json(), body: '{}' })),
    'developer key rotate',
  );
}

/** The workspace's own key rules (ADR 0798). `maxLifetimeDays: null` clears the workspace cap. */
export async function setWorkspaceKeyPolicy(patch: { disabled?: boolean; maxLifetimeDays?: number | null }): Promise<{ effective: KeyMintPolicy }> {
  return asJson(
    await fetch(`${keysUrl}/policy`, fetchOpts({ method: 'PUT', headers: json(), body: JSON.stringify(patch) })),
    'developer key policy',
  );
}

// ── ADR 0799 — approve a CLI sign-in ────────────────────────────────────────

export interface CliLoginRequest {
  userCode: string;
  label: string;
  requestedFrom: string;
  createdAt: string;
  expiresAt: string;
}
const cliLoginUrl = `${config.baseUrl}/host/openwop-app/cli-login/requests`;

/** Look up the sign-in a terminal is waiting on, by the code it shows. */
export async function getCliLoginRequest(userCode: string): Promise<{ request: CliLoginRequest; workspaceId: string }> {
  return asJson(await fetch(`${cliLoginUrl}/${encodeURIComponent(userCode)}`, fetchOpts({ headers: authedHeaders() })), 'cli sign-in');
}

export async function decideCliLogin(userCode: string, decision: 'approve' | 'deny'): Promise<void> {
  const res = await fetch(`${cliLoginUrl}/${encodeURIComponent(userCode)}/${decision}`, fetchOpts({ method: 'POST', headers: json(), body: '{}' }));
  if (!res.ok) await asJson(res, 'cli sign-in decision');
}

/** Whole days until a key expires (0 on its last day), or `null` if it does not. */
export function daysUntilExpiry(k: Pick<DeveloperKey, 'expiresAt'>, now: number = Date.now()): number | null {
  if (!k.expiresAt) return null;
  const at = Date.parse(k.expiresAt);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((at - now) / 86_400_000));
}

export async function revokeDeveloperKey(keyId: string): Promise<void> {
  const res = await fetch(`${keysUrl}/${encodeURIComponent(keyId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson(res, 'developer key revoke');
}

/** Which preset a key's declaration matches, if any. `unrestricted` is a key
 *  that declares nothing: the server reads that as its issuer's full authority. */
export function presetOfKey(k: Pick<DeveloperKey, 'scopes'>): ApiKeyPreset | 'unrestricted' | 'custom' {
  if (k.scopes.length === 0 || k.scopes.includes('*')) return 'unrestricted';
  const have = [...k.scopes].sort().join(' ');
  for (const p of ['run', 'read', 'cli'] as const) {
    if ([...API_KEY_PRESETS[p]].sort().join(' ') === have) return p;
  }
  return 'custom';
}

/** The absolute base URL a CLI or script should call. The SPA's own base may be
 *  a same-origin path (`/api`), which means nothing outside the browser. */
export function publicApiBaseUrl(origin: string = window.location.origin): string {
  return new URL(config.baseUrl, origin).toString().replace(/\/$/, '');
}

/** Shell setup for the OpenWOP CLI (`--api-key` > `OPENWOP_API_KEY` > saved config). */
export function cliSetupSnippet(baseUrl: string, token: string): string {
  return `export OPENWOP_BASE_URL=${baseUrl}\nexport OPENWOP_API_KEY=${token}`;
}
