/**
 * UI-plugins API client (ADR 0300). Talks to the host-extension endpoints that
 * back the `PluginFrame` loader (RFC 0117/0119):
 *   - list the plugins the host serves + its advertised isolation mechanism,
 *   - ensure a per-tenant demo artifact the reference viewer reads,
 *   - forward a ui-plugin/1 host-RPC message to the canonical host seam.
 * All authed + tenant-scoped via the shared `authedHeaders`/`fetchOpts` helpers.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const base = `${config.baseUrl}/host/openwop-app/ui-plugin`;

/** ui-plugin/1 method the host recognizes (mirror of the host allowlist). */
export type HostUiPluginMethod = 'artifact.read' | 'artifact.write' | 'host.toast' | 'host.navigate' | 'host.announce';

export interface ServedPlugin {
  packName: string;
  packVersion: string;
  pluginId: string;
  surface: 'artifact-viewer' | 'route' | 'settings-panel' | 'canvas-preview';
  hostApi: HostUiPluginMethod[];
  /** RFC 0130 — canvas-preview plugins: the canvas type id(s) they render. */
  canvasTypes?: string[];
  entryPath: string;
  /** ADR 0367 — the honest trust label: 'trusted' only when the kill-switch
   *  toggle is on AND the pinned-key verification (manifest + module bytes)
   *  passes on the host right now; otherwise 'community' (sandbox lane). */
  tier?: 'trusted' | 'community';
  /** Present iff tier === 'trusted' — the same-origin path the main-frame
   *  loader dynamic-imports (T1). */
  trustedEntryPath?: string;
}

export interface PluginList {
  /** The categorical isolation mechanism the host advertises (RFC 0119). */
  isolation: string;
  plugins: ServedPlugin[];
}

/**
 * Read the server's own sentence before falling back to a status code.
 *
 * The backend answers with the shared `ErrorEnvelope` (`{ error, message,
 * details }`) and these routes carry real text — including the deliberately
 * UNIFORM "Unknown plugin entry." that every trusted-lane failure path returns
 * (a security property: signature failure, revocation and a bad id must be
 * indistinguishable). Discarding it left the operator of a *security witness*
 * page reading "listPlugins returned 403", which says nothing about whether the
 * boundary held. Same shape as `environmentsClient.asJson`.
 */
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listPlugins(): Promise<PluginList> {
  const res = await fetch(`${base}/packs`, fetchOpts({ headers: authedHeaders() }));
  return asJson<PluginList>(res, 'listPlugins');
}

export async function ensureDemoArtifact(): Promise<{ artifactId: string; version: string }> {
  const res = await fetch(`${base}/demo-artifact`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<{ artifactId: string; version: string }>(res, 'ensureDemoArtifact');
}

/** The absolute URL the sandboxed loader fetches a plugin's entry bytes from. */
export function entryUrl(plugin: ServedPlugin): string {
  return `${config.baseUrl}${plugin.entryPath}`;
}

/** The absolute URL the T1 main-frame loader dynamic-imports (ADR 0367). Null
 *  unless the host labeled the plugin trusted — the FE never constructs the
 *  trusted path itself, so it can't race ahead of the host's verdict. */
export function trustedEntryUrl(plugin: ServedPlugin): string | null {
  return plugin.tier === 'trusted' && plugin.trustedEntryPath ? `${config.baseUrl}${plugin.trustedEntryPath}` : null;
}

/** Forward a ui-plugin/1 request envelope to the canonical host RPC seam
 *  (`POST …/ui-plugin/rpc`). Returns the host's response envelope. The seam
 *  enforces the closed allowlist + tenant isolation + canvas concurrency — the FE
 *  loader is a thin, isolation-preserving bridge, never a second dispatcher. */
export async function callHostRpc(message: unknown): Promise<unknown> {
  const res = await fetch(`${base}/rpc`, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ message }),
  }));
  return asJson<unknown>(res, 'callHostRpc');
}
