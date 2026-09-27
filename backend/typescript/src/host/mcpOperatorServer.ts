/**
 * Operator-configured outbound MCP server (H21 / ADR 0553 / RFC 0153).
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `host/mcpClient.ts` resolves an outbound call's peer from a `reach:'mcp'`
 * Connections provider whose manifest carries `mcpServer.url` — host-curated, so
 * an author can never supply a URL. Every built-in `reach:'mcp'` provider
 * (`google`, `slack`) is an OAuth product with a per-user Connection. There was
 * no way for an OPERATOR to point this host at an MCP server of their own: no
 * env, no boot secret, no route. A workflow that wanted a host-configured
 * server — the shape `conformance-mcp-tool-roundtrip` declares, and the shape a
 * self-hoster running an internal MCP server needs — had nowhere to go.
 *
 * ── The decision: synthesize a PROVIDER, do not fork the client ──────────────
 *
 * The obvious implementation is a second config lane read inside `mcpClient` —
 * "if no serverId, use `OPENWOP_MCP_SERVER_URL`". That forks `resolveTarget`,
 * which is the one function that holds the three fail-closed gates, and every
 * later reader has to ask which lane a given call took.
 *
 * So this module registers the operator's server as a **curated Connections
 * provider** (`registerProvider`, the same hook the Marketplace install uses).
 * From that moment it is an ordinary `reach:'mcp'` provider: resolution,
 * ADR 0028 governance, the RFC 0093 egress dispatcher, the `connectionUse[]`
 * stamp and the `untrustedContent: true` marking are all the existing code,
 * unchanged and unbranched. ONE MCP client, ONE resolution path.
 *
 * ── The one genuinely new branch: the credential ─────────────────────────────
 *
 * `resolveConnectionCredential` requires a per-user Connection row. A
 * host-global operator server has none by construction, and seeding a fake
 * Connection row to fit would put a placeholder secret on the wire. So the
 * synthesized manifest carries `operatorManaged: true` and `resolveTarget`
 * branches on THAT MARKER ALONE (`resolveOperatorMcpCredential` below):
 *
 *   - `OPENWOP_MCP_SERVER_TOKEN_REF` set ⇒ resolved through the BYOK secret
 *     resolver. Unresolvable ⇒ `null` ⇒ the client raises `mcp_not_connected`.
 *     A declared-but-missing token is a misconfiguration, never a silent
 *     downgrade to an unauthenticated call.
 *   - no token ref ⇒ the operator has declared the endpoint auth-less; the
 *     secret is `''` and `wireCall` omits the `Authorization` header entirely
 *     (it is written `if (target.secret)`), so no `Bearer ` is sent.
 *
 * No existing provider's credential path changes: `operatorManaged` is set here
 * and nowhere else.
 *
 * ── Egress posture ──────────────────────────────────────────────────────────
 *
 * NOT relaxed here. `resolveTarget` still requires `https://` unless
 * `webhookPrivateEgressAllowed()` (`OPENWOP_WEBHOOK_ALLOW_PRIVATE`) is on, and
 * the RFC 0093 dispatcher still refuses private ranges without it. A loopback
 * operator server is therefore reachable only under the test/conformance
 * posture that already opts into private egress — this module adds no default
 * that could put a plaintext or private-range target on a production deploy.
 *
 * The token ref resolves HOST-GLOBAL (scopeless), like `billing:stripe-key`, so
 * `OPENWOP_BYOK_EPHEMERAL=false` is required for it to load — under ephemeral
 * mode a scopeless ref resolves to `null` and this fails closed rather than
 * calling out unauthenticated.
 *
 * @see docs/adr/0553-mcp-2026-secure-versioned-adapter.md § "H21"
 * @see spec/v1/mcp-integration.md
 */

import { createLogger } from '../observability/logger.js';
import { resolveSecret } from '../byok/secretResolver.js';
import { getProvider, registerProvider, type ProviderManifest } from '../features/connections/providerRegistry.js';

const log = createLogger('connections.mcp.operator');

/** Provider id used when the operator does not name one. */
export const DEFAULT_OPERATOR_MCP_SERVER_ID = 'operator-mcp';

export interface OperatorMcpConfig {
  /** The Connections provider id the synthesized manifest registers under. */
  readonly id: string;
  /** Absolute URL of the operator's MCP server (JSON-RPC over HTTP). */
  readonly url: string;
  /** Catalog label. */
  readonly label: string;
  /** BYOK credential ref for the bearer, or `null` when the operator declared
   *  the endpoint auth-less. */
  readonly tokenRef: string | null;
}

const trimmed = (v: string | undefined): string | null => {
  const s = v?.trim();
  return s && s.length > 0 ? s : null;
};

/**
 * The operator's MCP server configuration, or `null` when unconfigured.
 *
 * Read fresh on every call rather than captured at import: the conformance boot
 * and the tests set these vars after module load, and a captured snapshot would
 * make the seam untestable without module surgery.
 */
export function operatorMcpConfig(): OperatorMcpConfig | null {
  const url = trimmed(process.env.OPENWOP_MCP_SERVER_URL);
  if (!url) return null;
  return {
    id: trimmed(process.env.OPENWOP_MCP_SERVER_ID) ?? DEFAULT_OPERATOR_MCP_SERVER_ID,
    url: url.replace(/\/$/, ''),
    label: trimmed(process.env.OPENWOP_MCP_SERVER_LABEL) ?? 'Operator MCP server',
    tokenRef: trimmed(process.env.OPENWOP_MCP_SERVER_TOKEN_REF),
  };
}

/**
 * The provider id a caller with NO `serverId` should use, or `null` when the
 * operator configured no server.
 *
 * Callers fail TYPED on `null` — never "success with no tool result", which
 * would let a run report a roundtrip that never left the host.
 */
export function operatorMcpServerId(): string | null {
  return operatorMcpConfig()?.id ?? null;
}

/** Is `serverId` the operator-managed server? Used by `mcpClient.resolveTarget`
 *  to pick the credential lane. Reads the REGISTERED manifest, not the env, so
 *  the marker cannot be spoofed by an env var that was never registered. */
export function isOperatorManagedMcpServer(serverId: string): boolean {
  return getProvider(serverId)?.operatorManaged === true;
}

/**
 * Resolve the operator server's bearer.
 *
 * Returns the secret (possibly `''` for a declared auth-less endpoint), or
 * `null` when a token ref was declared and did not resolve — fail-closed.
 */
export async function resolveOperatorMcpCredential(serverId: string): Promise<string | null> {
  const cfg = operatorMcpConfig();
  if (!cfg || cfg.id !== serverId) return null;
  if (!cfg.tokenRef) return '';
  const secret = await resolveSecret(cfg.tokenRef);
  if (secret === null || secret.length === 0) {
    // The REF is logged, never the value — and never the URL's credentials.
    log.error('operator MCP token ref did not resolve; refusing the call', {
      serverId,
      credentialRef: cfg.tokenRef,
    });
    return null;
  }
  return secret;
}

/** Manifest shape for the operator's server. Exported for the unit test so the
 *  assertion reads the same construction the boot registers. */
export function operatorMcpManifest(cfg: OperatorMcpConfig): ProviderManifest {
  return {
    id: cfg.id,
    label: cfg.label,
    category: 'integration',
    kind: cfg.tokenRef ? 'bearer' : 'custom',
    // Never an interactive flow: the operator supplies the credential out of
    // band (boot secret / vault), so there is no authorize/token endpoint and
    // nothing for a user to consent to.
    authFlow: 'none',
    reach: 'mcp',
    scopes: { read: [] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: ['core.openwop.mcp'],
    mcpServer: { url: cfg.url, transport: 'http' },
    operatorManaged: true,
  };
}

let registeredId: string | null = null;

/**
 * Register the operator's MCP server as a curated provider. Idempotent, and
 * safe to call when nothing is configured (it then does nothing).
 *
 * Re-registers when the configured id changes, so a test that repoints the env
 * does not leave the previous synthetic provider in the registry claiming a
 * stale URL.
 */
export function registerOperatorMcpServer(): void {
  const cfg = operatorMcpConfig();
  if (!cfg) return;
  if (registeredId === cfg.id && getProvider(cfg.id)?.mcpServer?.url === cfg.url) return;
  registerProvider(operatorMcpManifest(cfg));
  registeredId = cfg.id;
  // The URL is operator config, not a secret; the token ref is never logged
  // alongside it and the token itself never leaves `resolveOperatorMcpCredential`.
  log.info('registered operator-configured MCP server', {
    serverId: cfg.id,
    url: cfg.url,
    authenticated: cfg.tokenRef !== null,
  });
}

/** Test seam — forget the idempotence latch. Never called in production. */
export function _resetOperatorMcpRegistration(): void {
  registeredId = null;
}
