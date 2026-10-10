/**
 * ADR 0788 D5/D6 — the client for the "AI clients (MCP)" Access Hub tab.
 *
 * Three backend surfaces, none new to the wire:
 *  - `GET/PUT /host/openwop-app/mcp/exposure` — what external AI clients can
 *    reach in this workspace, the endpoint to point them at (the BACKEND says
 *    which URL, because the SPA's own `/api` base runs through a proxy whose
 *    timeout would cut a long tool call), and the per-tool switch;
 *  - the ADR 0270 developer-key routes, unchanged. A key minted here is named
 *    `MCP: <label>` — a naming convention, not a field, so the key routes stay
 *    as they are and the API keys tab (ADR 0800) still lists it. The key calls
 *    themselves live in `features/developer-keys/apiKeysClient.ts`, the one owner.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import {
  MCP_KEY_PREFIX,
  asJson,
  createDeveloperKey,
  listDeveloperKeys,
  revokeDeveloperKey,
  type DeveloperKey,
} from '../features/developer-keys/apiKeysClient.js';

export { MCP_KEY_PREFIX, type DeveloperKey };

export const MCP_MANAGE_SCOPE = 'host:mcp:manage';

export interface McpToolEntry {
  key: string;
  name: string;
  description: string;
  source: 'host' | 'workspace';
  safetyTier: 'read' | 'write' | string;
  approval: 'never' | 'conditional' | 'always' | string;
  requiredScopes: string[];
  featureToggle?: string;
  disabled: boolean;
}

export interface McpExposureView {
  /** Is the MCP mount switched on for this deployment? */
  enabled: boolean;
  endpoint: { url: string; derived: boolean; viaProxy: boolean };
  protocolVersions: string[];
  canManage: boolean;
  tools: McpToolEntry[];
}

/** The two presets a person picks from, mapped to the key's declared scopes.
 *  `act` carries `runs:create` because calling a workspace tool is a LAUNCH
 *  (the server narrows an `owk_` key to its declaration, ADR 0788 D1). */
export type KeyPreset = 'read' | 'act';
export const PRESET_SCOPES: Record<KeyPreset, string[]> = {
  read: ['workspace:read'],
  act: ['workspace:read', 'workspace:write', 'runs:create'],
};

const exposureUrl = `${config.baseUrl}/host/openwop-app/mcp/exposure`;
const json = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

export async function getMcpExposure(): Promise<McpExposureView> {
  return asJson(await fetch(exposureUrl, fetchOpts({ headers: authedHeaders() })), 'mcp exposure');
}

/** Switch ONE tool on or off. The server merges it into the stored set (a
 *  whole-set replace from this page's filtered view used to re-enable tools the
 *  admin could not see) and answers with the resulting set. */
export async function setMcpToolDisabled(key: string, disabled: boolean): Promise<{ disabled: string[]; updatedAt: string }> {
  return asJson(
    await fetch(exposureUrl, fetchOpts({ method: 'PATCH', headers: json(), body: JSON.stringify({ key, disabled }) })),
    'mcp exposure update',
  );
}

export async function listMcpKeys(): Promise<DeveloperKey[]> {
  return (await listDeveloperKeys()).filter((k) => k.name.startsWith(MCP_KEY_PREFIX));
}

export async function createMcpKey(label: string, preset: KeyPreset): Promise<{ token: string; key: DeveloperKey }> {
  return createDeveloperKey(`${MCP_KEY_PREFIX}${label}`, PRESET_SCOPES[preset]);
}

export const revokeMcpKey = revokeDeveloperKey;

/** A generic remote-server config: every client that supports remote MCP
 *  servers with a bearer header takes this shape (a named client's own file
 *  format is deliberately NOT claimed — this host has not been driven by one). */
export function clientConfigSnippet(url: string, token?: string): string {
  return JSON.stringify(
    { mcpServers: { openwop: { url, headers: { Authorization: `Bearer ${token ?? '<your key>'}` } } } },
    null,
    2,
  );
}
