/**
 * ADR 0466 — the built-in `google` provider's `mcpServer` field, asserted at the
 * connection seam (NODE-PACK-AUDIT NP-CONN-2).
 *
 * Two invariants:
 *  1. Shape honesty: the one BUILTIN carrying `mcpServer` declares the real
 *     first-party Google Calendar MCP endpoint — https, transport 'http'
 *     (streamable-HTTP, proto 2025-06-18) — so the calendarMcpAdapter never
 *     dials a non-TLS or made-up URL.
 *  2. Host-curated only: `mcpServer` is NOT a connection-pack concern — the §A
 *     manifest schema (`provider` additionalProperties:false) rejects a pack
 *     that tries to supply one. An author NEVER ships an MCP URL; the host
 *     curates it on the built-in (providerRegistry.ts).
 */
import { describe, it, expect } from 'vitest';
import { getProvider, listProviders } from '../providerRegistry.js';
import { installConnectionPackManifest } from '../connectionPackLoader.js';

describe('ADR 0466 builtin mcpServer honesty', () => {
  it('google declares the Calendar MCP server with an https URL and http transport', () => {
    const google = getProvider('google');
    expect(google).not.toBeNull();
    expect(google?.mcpServer).toEqual({
      url: 'https://calendarmcp.googleapis.com/mcp/v1',
      transport: 'http',
    });
  });

  it('every builtin mcpServer URL (present or future) is https', () => {
    for (const p of listProviders()) {
      // H21: an OPERATOR-managed provider is synthesized from env, not curated
      // in this file, so it is not a "builtin" and this assertion is not its
      // guard. Its plaintext rule is enforced where it belongs — `mcpClient
      // .resolveTarget` refuses a non-https operator URL unless the private-
      // egress posture is on (`mcp-operator-server.test.ts` pins both arms).
      // Without this skip the invariant would read as satisfied on a host that
      // simply has no operator server configured, which is not the same claim.
      if (p.operatorManaged) continue;
      if (p.mcpServer) {
        expect(p.mcpServer.url, `${p.id} mcpServer must be https`).toMatch(/^https:\/\//);
        expect(['http', 'sse']).toContain(p.mcpServer.transport);
      }
    }
  });

  it('rejects a connection pack that tries to supply provider.mcpServer (host-curated field)', () => {
    const outcome = installConnectionPackManifest({
      name: 'community.test.mcpserver-smuggle',
      version: '1.0.0',
      kind: 'connection',
      engines: { openwop: '>=1.0.0' },
      provider: {
        id: 'mcpserver-smuggle',
        displayName: 'MCP URL Smuggler',
        category: 'other',
        auth: { kind: 'api_key' },
        reach: { integration: { node: 'core.openwop.integration.test' } },
        mcpServer: { url: 'https://attacker.example/mcp', transport: 'http' },
      },
    });
    expect(outcome.installed).toBe(false);
  });
});
