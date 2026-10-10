/**
 * ADR 0851 (#4516) — the ONE place a request's client address is derived.
 *
 * Express `trust proxy` semantics (proxy-addr's closest-untrusted walk): the
 * chain is `[socket peer, xffN, …, xff1]`, closest hop first, and the answer is
 * the first address that is NOT a trusted proxy. Entries to the left of the
 * first untrusted one were written by the client and are never read.
 *
 * Trust is by address RANGE, not hop count, because the two doors differ by one
 * hop and nothing a client cannot forge tells them apart (MEASURED 2026-10-07,
 * ADR 0851 §Context):
 *   direct run.app / domain mapping : <client-supplied…>, <client>
 *   Firebase Hosting /api rewrite    : <client-supplied…>, <client>, <Hosting egress>
 * Hosting's egress is a Google address (skipped); a direct caller's appended
 * entry is its own (stops the walk).
 *
 * Deliberately NOT `app.set('trust proxy', …)` + `req.ip`: that also flips
 * `req.protocol`/`req.secure`, which host/requestOrigin.ts reads locally.
 * `isTrustedProxy` is the predicate shape `trust proxy` accepts if that ever changes.
 */

import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';

/** Loopback, private, link-local: a hop on our own network. */
const PRIVATE_CIDRS = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10',
  '::1/128', 'fc00::/7', 'fe80::/10',
];

/** Google's own front-end + egress netblocks — `goog.json` prefixes that do NOT
 *  overlap `cloud.json` (so no GCP customer address is trusted), narrowed to the
 *  front-end blocks, plus the documented GFE proxy ranges 35.191/16 + 130.211/22.
 *  Snapshot of 2026-10-07; every Firebase-door egress address in 5,000 logged
 *  requests fell inside 74.125, 192.178, 66.102, 64.233, 66.249 or 142.250. */
export const GOOGLE_FRONT_END_CIDRS: readonly string[] = [
  '35.191.0.0/16', '130.211.0.0/22',
  '64.233.160.0/19', '66.102.0.0/20', '66.249.64.0/19', '72.14.192.0/18', '74.125.0.0/16',
  '108.177.0.0/17', '142.250.0.0/15', '172.217.0.0/16', '172.253.0.0/16', '173.194.0.0/16',
  '192.178.0.0/15', '209.85.128.0/17', '216.58.192.0/19', '216.239.32.0/19',
  '2001:4860::/32', '2404:6800::/32', '2607:f8b0::/32', '2800:3f0::/32', '2a00:1450::/32', '2c0f:fb50::/32',
];

function addCidr(list: BlockList, cidr: string): boolean {
  const [net, bits] = cidr.trim().split('/');
  const family = net ? isIP(net) : 0;
  const prefix = Number(bits);
  if (!net || family === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return false;
  list.addSubnet(net, prefix, family === 4 ? 'ipv4' : 'ipv6');
  return true;
}

let cached: { key: string; list: BlockList } | undefined;

/** Built once per distinct env value (tests flip it). An invalid operator CIDR
 *  is skipped, never fatal: a typo must not take the limiter down with it. */
function trustedList(): BlockList {
  const extra = process.env.OPENWOP_TRUSTED_PROXY_CIDRS ?? '';
  const defaults = process.env.OPENWOP_TRUSTED_PROXY_DEFAULTS === 'private' ? 'private' : 'google';
  const key = `${defaults}|${extra}`;
  if (cached?.key === key) return cached.list;
  const list = new BlockList();
  for (const c of PRIVATE_CIDRS) addCidr(list, c);
  if (defaults === 'google') for (const c of GOOGLE_FRONT_END_CIDRS) addCidr(list, c);
  for (const c of extra.split(',')) if (c.trim()) addCidr(list, c);
  cached = { key, list };
  return list;
}

/** `::ffff:a.b.c.d` → `a.b.c.d`; strips `host:port`, `[v6]:port` and `[v6]`.
 *  Returns the trimmed input unchanged when it is not an address. */
export function normaliseAddress(raw: string): string {
  let a = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'));
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) a = mapped[1]!;
  return a;
}

/** True when `addr` is a proxy hop we operate or the platform operates. A
 *  non-address is never trusted, so the walk stops on it. */
export function isTrustedProxy(addr: string): boolean {
  const a = normaliseAddress(addr);
  const family = isIP(a);
  if (family === 0) return false;
  return trustedList().check(a, family === 4 ? 'ipv4' : 'ipv6');
}

/** The socket peer is the platform's front end on Cloud Run (`K_SERVICE` is set
 *  by the platform); the container's peer address is not documented, and
 *  mistaking it for a client would put every user in one bucket. */
function socketPeerTrusted(peer: string): boolean {
  return Boolean(process.env.K_SERVICE) || isTrustedProxy(peer);
}

/** The request's client address. See the module comment for the rule. */
export function clientIp(req: Request): string {
  const peer = normaliseAddress(req.socket.remoteAddress ?? '');
  if (!socketPeerTrusted(peer)) return peer || 'unknown';
  const hops = (req.header('x-forwarded-for') ?? '').split(',').map((h) => normaliseAddress(h)).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(hops[i]!)) return hops[i]!;
  }
  // Every hop trusted (e.g. a Google crawler on the direct door): the farthest.
  return hops[0] ?? (peer || 'unknown');
}

/** A genuine direct loopback connection — no proxy hop at all. Behind a front
 *  end real traffic always carries `X-Forwarded-For`, so the header cannot be
 *  spoofed into this (a client can add the header, never remove the GFE's). */
export function isDirectLoopback(req: Request): boolean {
  if (req.header('x-forwarded-for')) return false;
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
