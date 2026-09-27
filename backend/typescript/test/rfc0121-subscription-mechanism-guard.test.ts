/**
 * RFC 0121 — the subscription-rail MECHANISM drift guard (ADR 0757 §G2).
 *
 * Why this file exists. RFC 0121 gap G2 (ruled 2026-09-18) says the credential-
 * acquisition mechanism is an OFFICIAL-CLIENT subprocess harness, and direct API
 * calls under a borrowed session are out of scope; the ruling cites "a drift
 * guard asserting no login code" in this host. ADR 0180's commit claimed such a
 * guard ("A drift-guard test asserts no such code exists") — but no test ever
 * did. ADR 0757 writes it now, and scopes it deliberately: the ONE sanctioned
 * login flow on the rail is GitHub Copilot's OAuth App connect (the RFC 0121
 * cleared provider), and even that token is used only through GitHub's official
 * Copilot SDK in the loopback sidecar — never by this host over HTTP.
 *
 * Each block is a source-text assertion over the tracked trees, so a future
 * change that adds a private consumer endpoint, a direct Copilot HTTP call, a
 * vendor-CLI spawn in the provider path, or a second login flow fails here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const BACKEND_SRC = join(REPO, 'backend/typescript/src');
const SHIM_SRC = join(REPO, 'clients/subscription-provider/src');
const SIDECAR_SRC = join(REPO, 'clients/copilot-provider/src');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.test\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const read = (p: string): string => readFileSync(p, 'utf8');
const rel = (p: string): string => relative(REPO, p);
const filesMatching = (files: string[], re: RegExp): string[] => files.filter((f) => re.test(read(f))).map(rel).sort();

const backendFiles = walk(BACKEND_SRC);
const shimFiles = walk(SHIM_SRC);
const sidecarFiles = walk(SIDECAR_SRC);

describe('RFC 0121 G2 — no borrowed-session / private-endpoint code anywhere on the rail', () => {
  it('the trees under guard are present (a vacuous walk is a failure, not a pass)', () => {
    expect(backendFiles.length).toBeGreaterThan(100);
    expect(sidecarFiles.length).toBeGreaterThan(0);
    expect(shimFiles.length).toBeGreaterThan(0);
  });

  // Consumer web/private API hosts a borrowed-session integration would call.
  const PRIVATE = /claude\.ai\/api|chatgpt\.com\/backend-api|chat\.openai\.com\/backend-api|gemini\.google\.com\/_|githubcopilot\.com|copilot_internal/;
  it('names no provider-private consumer endpoint (backend src, the ADR 0182 shim, the Copilot sidecar)', () => {
    expect(filesMatching([...backendFiles, ...shimFiles, ...sidecarFiles], PRIVATE)).toEqual([]);
  });
});

describe('RFC 0121 G2 — Copilot is reached ONLY through the official SDK harness', () => {
  it('the backend never imports the Copilot SDK (the harness lives in the loopback sidecar)', () => {
    expect(filesMatching(backendFiles, /@github\/copilot-sdk/)).toEqual([]);
  });

  it('the sidecar reaches Copilot only via @github/copilot-sdk: no fetch, no outbound http(s) client', () => {
    expect(filesMatching(sidecarFiles, /@github\/copilot-sdk/)).toEqual(['clients/copilot-provider/src/bin.js']);
    expect(filesMatching(sidecarFiles, /\bfetch\s*\(|node:https|\bhttps?\.request\s*\(|\bundici\b|\baxios\b/)).toEqual([]);
  });
});

describe('RFC 0121 G2 / ADR 0182 — no vendor-CLI spawn in the backend provider path', () => {
  it('the provider/subscription modules import no child_process', () => {
    const providerPath = backendFiles.filter((f) => /\/src\/(aiProviders|byok|providers|host\/exchange)\//.test(f));
    expect(providerPath.length).toBeGreaterThan(5);
    expect(filesMatching(providerPath, /child_process/)).toEqual([]);
  });
});

describe('RFC 0121 G2 — exactly ONE login flow on the rail, scoped to Copilot', () => {
  it('only byok/copilotOAuth.ts names a GitHub OAuth endpoint in backend src', () => {
    expect(filesMatching(backendFiles, /github\.com\/login\/oauth/)).toEqual(['backend/typescript/src/byok/copilotOAuth.ts']);
  });

  it('that flow requests no OAuth scope (least scope)', () => {
    const src = read(join(BACKEND_SRC, 'byok/copilotOAuth.ts'));
    expect(src).not.toMatch(/searchParams\.set\(\s*'scope'/);
  });
});
