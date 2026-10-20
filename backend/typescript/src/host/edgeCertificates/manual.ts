/**
 * ADR 0906 D1 — the `manual` provider: the operator issues certificates
 * (`scripts/custom-domain-edge.sh host <hostname>`). Every method is a no-op
 * that touches no network. The engine short-circuits before calling it; it
 * exists so the port has a complete default and a white-label adopter off GCP
 * has a named, honest choice.
 */
import type { EdgeCertificateProvider } from './port.js';

export const manualEdgeProvider: EdgeCertificateProvider = {
  id: 'manual',
  prepare: async () => ({ done: true, value: { handle: {}, dnsRecords: [] } }),
  issue: async (_hostname, handle) => ({ done: true, value: handle }),
  status: async () => ({ tls: 'awaiting_dns', issue: { reason: 'manual', detail: 'Certificates are issued by the operator.' } }),
  release: async () => 'released',
};
