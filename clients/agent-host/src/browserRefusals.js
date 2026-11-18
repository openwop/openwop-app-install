// ADR 1136 P2b — what the companion's browser refuses ON ITS OWN, whatever the
// host asks. The host already applies the session's allowlist; these are the
// executor's floor (ADR 1136 P2 condition 6), so a compromised or mistaken host
// still cannot point the person's browser at their own machine or network.
//
//   - any scheme but https and http (`file:`, `chrome:`, `data:`, `javascript:`,
//     `about:` other than about:blank, `blob:`, `view-source:` …);
//   - a URL carrying a username or password;
//   - a private, loopback, link-local or unique-local address, `localhost`, and
//     `.local` / `.internal` / `.localhost` names.
//
// `allowHosts` exists for the companion's own tests against a local fixture
// page. It is not reachable from the command line.

import { isIP } from 'node:net';

const PRIVATE_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function ipv6Private(ip) {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return mapped ? ipv4Private(mapped[1]) : false;
}

/** True for a host the browser must never reach. */
export function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  const kind = isIP(h);
  if (kind === 4) return ipv4Private(h);
  if (kind === 6) return ipv6Private(h);
  return PRIVATE_NAME.test(h);
}

/**
 * Why a main-frame navigation to `raw` is refused, or null when it may go.
 * @param {string} raw
 * @param {{ allowHosts?: readonly string[] }} [opts]
 */
export function navigationRefusal(raw, opts = {}) {
  let url;
  try { url = new URL(raw); } catch { return 'unparseable'; }
  if (url.href === 'about:blank') return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `scheme:${url.protocol.replace(/:$/, '')}`;
  if (url.username || url.password) return 'credentialed';
  if (opts.allowHosts?.includes(url.hostname)) return null;
  if (isPrivateHost(url.hostname)) return 'private_address';
  return null;
}

/**
 * Why a sub-resource request is refused, or null. Only the private-network rule
 * applies here: a page may load its own images and scripts, but not reach the
 * person's network or a non-web scheme.
 */
export function requestRefusal(raw, opts = {}) {
  let url;
  try { url = new URL(raw); } catch { return 'unparseable'; }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return null; // inline content the page itself made
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `scheme:${url.protocol.replace(/:$/, '')}`;
  if (opts.allowHosts?.includes(url.hostname)) return null;
  if (isPrivateHost(url.hostname)) return 'private_address';
  return null;
}
