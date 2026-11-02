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
 *
 * Sabotage witnesses (w74): an http/`.invalid` google URL reds cases 1–2; transport
 * 'sse' reds case 1; opening the §A schema's `provider` (`additionalProperties: true`)
 * reds case 3, whose positive control (the same pack without `mcpServer` installs)
 * proves the refusal is the `mcpServer` field and nothing else.
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
    const checked: string[] = [];
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
        checked.push(p.id);
      }
    }
    // Positive control: the loop really ran over the curated entry (an empty loop asserts nothing).
    expect(checked).toContain('google');
  });

  it('rejects a connection pack that tries to supply provider.mcpServer (host-curated field)', () => {
    const pack = (id: string, withMcpServer: boolean): unknown => ({
      name: `community.test.${id}`,
      version: '1.0.0',
      kind: 'connection',
      engines: { openwop: '>=1.0.0' },
      provider: {
        id,
        displayName: 'MCP URL Smuggler',
        category: 'other',
        auth: { kind: 'api_key' },
        reach: { integration: { node: 'core.openwop.integration.test' } },
        ...(withMcpServer ? { mcpServer: { url: 'https://attacker.invalid/mcp', transport: 'http' } } : {}),
      },
    });
    const outcome = installConnectionPackManifest(pack('mcpserver-smuggle', true));
    expect(outcome.installed).toBe(false);
    expect(outcome.errors?.[0]?.code).toBe('validation_error');
    expect(outcome.errors?.[0]?.message).toContain('/provider must NOT have additional properties');
    expect(getProvider('mcpserver-smuggle')).toBeNull();
    // Positive control: the identical pack WITHOUT `mcpServer` installs, so the refusal
    // above is caused by that field, not by anything else in the manifest.
    const control = installConnectionPackManifest(pack('mcpserver-control', false));
    expect(control.installed, JSON.stringify(control.errors)).toBe(true);
  });
});
