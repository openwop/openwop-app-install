/**
 * ADR 0906 — the edge-certificate seam's entry point: resolve the configured
 * provider. `null` means configured-but-not-ready: make no edge calls and let
 * the domains page say why (`loadEdgeConfig(...).reason`).
 */
import { loadEdgeConfig, type EdgeConfig } from './config.js';
import { manualEdgeProvider } from './manual.js';
import { createGcpCertificateManagerProvider } from './gcpCertificateManager.js';
import type { EdgeCertificateProvider } from './port.js';

export function resolveEdgeProvider(cfg: EdgeConfig = loadEdgeConfig()): EdgeCertificateProvider | null {
  if (cfg.provider === 'manual') return manualEdgeProvider;
  if ('ready' in cfg && cfg.ready && cfg.provider === 'gcp-certificate-manager') {
    return createGcpCertificateManagerProvider({
      certMap: cfg.certMap,
      ...(cfg.project ? { project: cfg.project } : {}),
      ...(cfg.serviceAccount ? { impersonate: cfg.serviceAccount } : {}),
    });
  }
  return null;
}

export { loadEdgeConfig } from './config.js';
export type { EdgeConfig } from './config.js';
export type { CustomDomainEdge, DnsRecord, EdgeTlsState, EdgeCertificateProvider } from './port.js';
