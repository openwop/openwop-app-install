/**
 * ADR 0906 D1 — which edge provider this deployment runs, read from env.
 *
 * Fail closed: anything other than a fully configured provider makes NO edge
 * calls. An unknown provider name is reported as not ready, never silently
 * downgraded to `manual` — the operator asked for something, and the domains
 * page must say it is not working rather than pretend all is well.
 */
import type { EdgeProviderId } from './port.js';

export type EdgeConfig =
  | { provider: 'manual' }
  | {
    provider: 'gcp-certificate-manager';
    ready: true;
    certMap: string;
    /** The project holding the map; when absent the metadata server's project is used. */
    project?: string;
    /** Shown to customers as the routing target; optional display hints. */
    lbIp?: string;
    edgeHostname?: string;
    /** D7 — the dedicated service account to impersonate for Certificate Manager calls. */
    serviceAccount?: string;
  }
  | { provider: EdgeProviderId | 'unknown'; ready: false; reason: string };

/** Certificate Manager resource ids: lowercase, start with a letter, ≤ 63 chars. */
const RESOURCE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
/** GCP project ids: 6–30 chars, lowercase letters, digits, dashes, start with a letter. */
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const SA_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function loadEdgeConfig(env: NodeJS.ProcessEnv = process.env): EdgeConfig {
  const raw = (env['OPENWOP_CUSTOM_DOMAIN_EDGE'] ?? '').trim();
  if (raw === '' || raw === 'manual') return { provider: 'manual' };
  if (raw !== 'gcp-certificate-manager') {
    return { provider: 'unknown', ready: false, reason: `OPENWOP_CUSTOM_DOMAIN_EDGE="${raw.slice(0, 40)}" is not a known provider (manual, gcp-certificate-manager)` };
  }
  const certMap = (env['OPENWOP_CUSTOM_DOMAIN_CERT_MAP'] ?? '').trim();
  if (!certMap) return { provider: raw, ready: false, reason: 'OPENWOP_CUSTOM_DOMAIN_CERT_MAP is not set' };
  if (!RESOURCE_ID_RE.test(certMap)) return { provider: raw, ready: false, reason: 'OPENWOP_CUSTOM_DOMAIN_CERT_MAP is not a valid Certificate Manager map id' };
  const project = (env['OPENWOP_CUSTOM_DOMAIN_EDGE_PROJECT'] ?? '').trim();
  if (project && !PROJECT_RE.test(project)) return { provider: raw, ready: false, reason: 'OPENWOP_CUSTOM_DOMAIN_EDGE_PROJECT is not a valid project id' };
  const serviceAccount = (env['OPENWOP_CUSTOM_DOMAIN_EDGE_SA'] ?? '').trim();
  if (serviceAccount && !SA_RE.test(serviceAccount)) return { provider: raw, ready: false, reason: 'OPENWOP_CUSTOM_DOMAIN_EDGE_SA is not a service-account email' };
  const lbIp = (env['OPENWOP_CUSTOM_DOMAIN_LB_IP'] ?? '').trim();
  const edgeHostname = (env['OPENWOP_CUSTOM_DOMAIN_EDGE_HOSTNAME'] ?? '').trim().toLowerCase().replace(/\.$/, '');
  return {
    provider: raw,
    ready: true,
    certMap,
    ...(project ? { project } : {}),
    ...(serviceAccount ? { serviceAccount } : {}),
    ...(IPV4_RE.test(lbIp) ? { lbIp } : {}),
    ...(HOST_RE.test(edgeHostname) ? { edgeHostname } : {}),
  };
}
