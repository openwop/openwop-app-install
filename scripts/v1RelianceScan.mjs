/**
 * The scanner behind `check-v1-reliance.mjs` (ADR 0642), split out so its reach
 * can be pinned by a test (`backend/typescript/test/check-v1-reliance.test.ts`)
 * instead of trusted.
 *
 * ADR 0786 — ONE third-party exemption, and its reach is deliberate:
 *   - Stripe's REST API is versioned `/v1/…`. Those paths are STRIPE's, not the
 *     OpenWOP wire, and no OpenWOP cutover moves them. Stripe HTTP has ONE owner
 *     (`features/billing/stripeApi.ts`) and ONE choke (`stripeRequest(`), so a line
 *     is exempt only when it is IN that file AND calls `stripeRequest(` on the same
 *     line. Keying on the choke beats a path allowlist that drifts.
 *   - The scan is LINE-based, so a multi-line call whose `/v1/…` argument sits on
 *     its own line is COUNTED. Stated, pinned by a test, and conservative: the
 *     exemption can only ever under-reach.
 *   - `stripeChokeViolations` makes the exemption unable to hide an OpenWOP path:
 *     `stripeRequest(` anywhere else is a violation (a same-named wrapper could
 *     carry an OpenWOP call), and so is `stripeApiBase()` no longer defaulting to
 *     `https://api.stripe.com` (a path sent through the choke must only ever reach
 *     Stripe).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const STRIPE_CHOKE_FILE = 'features/billing/stripeApi.ts';
export const V1_PATH = '/v1/[a-zA-Z0-9._{}$/-]*';

/** Is this code line an exempt Stripe call? `file` is the path as grep printed it. */
export function isThirdPartyApiCall(file, line) {
  return file.replace(/\\/g, '/').endsWith(STRIPE_CHOKE_FILE) && /\bstripeRequest\(/.test(line);
}

/**
 * Every CODE-line match of `pattern` under `dir` (relative to `root`) — comments,
 * test files (via `excludes`) and exempt third-party calls excluded.
 */
export function scanMatches(root, dir, pattern, includes, excludes = []) {
  const args = ['-rnE', pattern, dir];
  for (const inc of includes) args.push(`--include=${inc}`);
  for (const ex of excludes) args.push(ex);
  let lines;
  try {
    lines = execFileSync('grep', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
  } catch { return []; }           // grep exits 1 on no match
  const re = new RegExp(pattern, 'g');
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    const file = /^([^:]+):\d+:/.exec(line)?.[1] ?? '';
    const text = line.replace(/^[^:]+:\d+:/, '');          // strip `path:line:`
    const t = text.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (isThirdPartyApiCall(file, text)) continue;
    for (const m of text.match(re) ?? []) out.push(m);
  }
  return out;
}

/** Reasons the Stripe exemption would be unsafe in the tree at `root` (empty = safe). */
export function stripeChokeViolations(root, srcDir = 'backend/typescript/src') {
  const out = [];
  let hits = [];
  try {
    hits = execFileSync('grep', ['-rlE', '\\bstripeRequest\\(', srcDir, '--include=*.ts'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch { hits = []; }
  for (const f of hits) {
    if (!f.replace(/\\/g, '/').endsWith(STRIPE_CHOKE_FILE)) {
      out.push(`stripeRequest( appears outside ${STRIPE_CHOKE_FILE}: ${f} — the v1 exemption is keyed on the ONE Stripe choke`);
    }
  }
  const choke = join(root, srcDir, STRIPE_CHOKE_FILE);
  if (existsSync(choke)) {
    const src = readFileSync(choke, 'utf8');
    if (!/function stripeApiBase\(\)[\s\S]{0,200}\?\?\s*'https:\/\/api\.stripe\.com'/.test(src)) {
      out.push(`${STRIPE_CHOKE_FILE}: stripeApiBase() no longer defaults to 'https://api.stripe.com' — a path sent through stripeRequest( might not be Stripe's`);
    }
  }
  return out;
}
