/**
 * Connection credential injection at the HTTP egress seam (ADR 0024 §4 / D1,
 * Option C). The host's `ctx.http.safeFetch` (RFC 0076 §B) attaches the run's
 * acting human's credential to an outbound call — host-side, AFTER the pack's
 * `sanitizeHeaders` stripped any author-supplied `Authorization`, never via
 * workflow `config.headers` (D1).
 *
 * OPT-IN + DOUBLE GATE (Option C, ratified by /architect):
 *   1. The run consents by allow-listing providers in `configurable.connections`
 *      (`["google", …]`); this fn is only built for such runs.
 *   2. The token attaches ONLY when the outbound URL's host matches a HOST-CURATED
 *      `ProviderManifest.apiHosts` for an allow-listed provider — an eTLD+1
 *      boundary match (exact or subdomain), NEVER substring. An author-supplied
 *      URL cannot widen the manifest, so a token can only reach the provider's
 *      real hosts (`https://attacker.com` ⇒ no injection).
 *   3. The credential is resolved as the run's `actingUserId` (the broker enforces
 *      `connections:use` for org connections, fail-closed).
 *
 * SECURITY: token only over https; a token-bearing request MUST NOT follow a
 * redirect (could resend `Authorization` to another host); SSRF defense reuses
 * the audited RFC 0093 guard (denied-range predicate + pinned-resolution
 * dispatcher) — never reimplemented. The token never lands in `ctx.config`, an
 * event, the run doc, or a log.
 */

import { fetch as undiciFetch } from 'undici';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import type { HostSafeFetch } from '../executor/types.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { resolveConnectionCredential } from '../features/connections/connectionsService.js';
import { isDeniedWebhookHost, webhookEgressDispatcher, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';

const log = createLogger('connections.inject');

/**
 * Does `requestHost` belong to `apiHost` at an eTLD+1 boundary? True iff it is
 * exactly `apiHost` or a subdomain (`*.apiHost`). Rejects substring spoofs like
 * `googleapis.com.evil.com`. (The security-critical predicate — unit-tested.)
 */
export function hostMatchesApi(requestHost: string, apiHost: string): boolean {
  const h = requestHost.toLowerCase().replace(/\.$/, '');
  const a = apiHost.toLowerCase().replace(/\.$/, '');
  return h === a || h.endsWith(`.${a}`);
}

/** The first allow-listed provider whose curated apiHosts match this URL host. */
function matchAllowedProvider(requestHost: string, allowed: readonly string[]): string | null {
  for (const provider of allowed) {
    const hosts = getProvider(provider)?.apiHosts;
    if (hosts && hosts.some((ah) => hostMatchesApi(requestHost, ah))) return provider;
  }
  return null;
}

export interface ConnectionEgressDeps {
  storage: Storage;
  tenantId: string;
  runId: string;
  /** The acting human (run.metadata.actingUserId). Absent ⇒ system run ⇒ the
   *  broker withholds user/org connections (fail-closed). */
  actingUserId?: string;
  /** Org context for the resolver (the workspace-root org; org connections + the
   *  connections:use gate resolve against it). */
  orgId?: string;
  /** Providers the run consented to (run.configurable.connections). */
  allowedProviders: readonly string[];
}

/** Build the per-run `ctx.http.safeFetch`. Provided only for opted-in runs, so
 *  non-Connections runs keep the pack's own egress fallback unchanged. */
export function makeConnectionSafeFetch(deps: ConnectionEgressDeps): HostSafeFetch {
  return async (rawUrl, init = {}) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`invalid URL: ${rawUrl}`);
    }

    // SSRF (RFC 0093): reject a denied hostname up front; the pinned dispatcher
    // re-validates the resolved address at connect time (anti-rebinding TOCTOU).
    if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(url.hostname)) {
      throw new Error(`destination blocked: ${url.hostname}`);
    }

    // The pack hands a plain, already-sanitized headers object (Authorization
    // stripped). Copy it, then host-inject the credential on top.
    const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
    let injected = false;

    // Tokens go over https only — EXCEPT when private egress is explicitly
    // enabled (local dev / tests), where loopback http is allowed. Production
    // (env unset) stays strictly https.
    const transportOk = url.protocol === 'https:' || webhookPrivateEgressAllowed();
    const provider = transportOk ? matchAllowedProvider(url.hostname, deps.allowedProviders) : null;
    if (provider) {
      const resolved = await resolveConnectionCredential({
        tenantId: deps.tenantId,
        provider,
        ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
        ...(deps.orgId ? { orgId: deps.orgId } : {}),
      });
      if (resolved && (resolved.connection.kind === 'oauth2' || resolved.connection.kind === 'bearer')) {
        headers.authorization = `Bearer ${resolved.secret}`;
        injected = true;
        await stampConnectionUse(deps.storage, deps.runId, resolved.provenance);
      } else if (resolved) {
        // api_key/basic carry provider-specific header shapes — deferred (v1
        // auto-injects oauth2/bearer only); the connection still exists + works
        // via an explicit author header if they have the secret out-of-band.
        log.info('connection matched but kind is not auto-injectable in v1', { provider, kind: resolved.connection.kind });
      }
    }

    return undiciFetch(rawUrl, {
      ...init,
      headers,
      dispatcher: webhookEgressDispatcher(),
      // A token-bearing request must not follow a redirect (it could resend the
      // Authorization to another host). Un-injected calls keep default behavior.
      ...(injected ? { redirect: 'error' as const } : {}),
    });
  };
}

export interface ConnectionUseProvenance {
  connectionId: string;
  provider: string;
  [k: string]: unknown;
}

/**
 * Stamp RFC 0079 provenance onto `run.metadata.connectionUse[]` (ADR 0024 D2 —
 * "which human used which org credential, for what"). Best-effort + deduped by
 * connectionId; a read-modify-write race across parallel nodes is acceptable at
 * sample scale (worst case: one duplicate stamp dropped). Replay-safe — read
 * verbatim on `:fork`, never recomputed. Shared by every broker consumer (the
 * http egress seam + the integration adapters).
 */
export async function stampConnectionUse(storage: Storage, runId: string, prov: ConnectionUseProvenance): Promise<void> {
  try {
    const run = await storage.getRun(runId);
    if (!run) return;
    const meta = (run.metadata ?? {}) as Record<string, unknown>;
    const uses = Array.isArray(meta.connectionUse) ? (meta.connectionUse as ConnectionUseProvenance[]) : [];
    if (uses.some((u) => u.connectionId === prov.connectionId)) return;
    await storage.updateRun(runId, { metadata: { ...meta, connectionUse: [...uses, prov] } });
  } catch (err) {
    log.warn('connectionUse stamp failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }
}
