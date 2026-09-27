/**
 * Seed helpers for the reference UCP-over-MCP merchant (ADR 0260) — a demo `reach:'mcp'` merchant
 * + a per-tenant Connection so the UCP buyer can be pointed at it to VALIDATE the `ucp.<op>`
 * convention (ADR 0258) end-to-end, instead of waiting for a real external merchant.
 *
 * Rides the fail-closed `exampleDataSeedEnabled()` gate via the seeder registry (OFF in the
 * enterprise/`auth` posture). Registers the provider globally (idempotent upsert) and creates a
 * WORKSPACE-scoped connection for the tenant — the scope the autonomous/node buyer path resolves
 * (ADR 0258 §Identity). The merchant catalog + orders live in `commerceService` (no new store).
 *
 * The buyer only REACHES this merchant when the demo route is mounted
 * (`OPENWOP_UCP_REF_MERCHANT_ENABLED=true`) and, for the loopback default URL, private egress is
 * allowed (`OPENWOP_WEBHOOK_ALLOW_PRIVATE=true`) — both dev/demo flags, off in a real deploy.
 */
import { registerProvider } from '../features/connections/providerRegistry.js';
import { createSecretConnection, listConnections, revokeConnection } from '../features/connections/connectionsService.js';
import { ensureReferenceCatalog, REF_MERCHANT_PROVIDER } from '../features/commerce/ucp/referenceUcpMerchant.js';

const DEMO_SECRET = 'demo-ucp-merchant-token'; // a placeholder demo credential (ephemeral store in demo mode)

/** The merchant endpoint the buyer's mcpClient POSTs to. Set `OPENWOP_UCP_REF_MERCHANT_URL` to the
 *  deploy's own public URL; defaults to a loopback dev route (which also needs
 *  `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` for the buyer to egress to it). */
function merchantUrl(): string {
  return process.env.OPENWOP_UCP_REF_MERCHANT_URL ?? 'http://127.0.0.1:8080/v1/host/openwop-app/dev/ucp-merchant/mcp';
}

function registerRefProvider(): void {
  registerProvider({
    id: REF_MERCHANT_PROVIDER,
    label: 'UCP Reference Merchant (demo)',
    kind: 'bearer',
    authFlow: 'none',
    reach: 'mcp',
    scopes: { read: [] },
    refreshable: false,
    defaultScopes: [],
    consumerNodes: ['core.openwop.mcp'],
    mcpServer: { url: merchantUrl(), transport: 'http' },
  });
}

export async function countUcpReferenceMerchant(tenantId: string): Promise<number> {
  return (await listConnections(tenantId)).filter((c) => c.provider === REF_MERCHANT_PROVIDER).length;
}

export async function seedUcpReferenceMerchant(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  await ensureReferenceCatalog();  // the merchant's catalog (global, idempotent — real commerce products)
  registerRefProvider();           // register the reach:'mcp' provider (global upsert)
  if ((await countUcpReferenceMerchant(tenantId)) > 0) return { created: 0, details: { skipped: 'connection already seeded' } };
  await createSecretConnection({ tenantId, provider: REF_MERCHANT_PROVIDER, kind: 'bearer', secret: DEMO_SECRET, scope: 'workspace', displayName: 'UCP Reference Merchant (demo)' });
  return { created: 1 };
}

export async function clearUcpReferenceMerchant(tenantId: string): Promise<{ cleared: number }> {
  const conns = (await listConnections(tenantId)).filter((c) => c.provider === REF_MERCHANT_PROVIDER);
  for (const c of conns) await revokeConnection(tenantId, c.connectionId);
  return { cleared: conns.length };
}
