/**
 * Dev/demo-only mount for the reference UCP-over-MCP merchant (ADR 0260).
 *
 * OFF by default — mounted ONLY when `OPENWOP_UCP_REF_MERCHANT_ENABLED=true` (a DEV/DEMO flag,
 * never a real deploy; the boot log warns loudly when on). It serves a demo merchant the app's
 * OWN UCP buyer shops to validate the `ucp.<op>` convention (ADR 0258). It moves NO money — see
 * `referenceUcpMerchant.ts`. Non-normative host-ext surface under `/v1/host/openwop-app/dev/*`.
 */
import type { Express } from 'express';
import { createLogger } from '../observability/logger.js';
import { handleUcpMerchantRpc } from '../features/commerce/ucp/referenceUcpMerchant.js';

const log = createLogger('routes.ucpRefMerchant');

export function registerUcpRefMerchantRoutes(app: Express): void {
  if (process.env.OPENWOP_UCP_REF_MERCHANT_ENABLED !== 'true') {
    log.info('reference UCP merchant mount disabled (set OPENWOP_UCP_REF_MERCHANT_ENABLED=true — DEV/DEMO only)');
    return;
  }
  log.warn('reference UCP merchant ENABLED — POST /v1/host/openwop-app/dev/ucp-merchant/mcp serves a DEMO merchant (no real payment). NEVER enable in a real deploy.');
  app.post('/v1/host/openwop-app/dev/ucp-merchant/mcp', async (req, res) => {
    // Always HTTP 200 with a JSON-RPC envelope (errors ride `error`, per JSON-RPC) so the buyer's
    // mcpClient parses the envelope rather than an HTTP failure.
    const out = await handleUcpMerchantRpc(req.body);
    res.status(200).json(out);
  });
}
