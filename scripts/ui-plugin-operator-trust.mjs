#!/usr/bin/env node
/**
 * ADR 0840 D5 (RFC 0238 §D.1) — produce an OPENWOP_UI_PLUGIN_OPERATOR_TRUST entry
 * that installs ONE front-end plugin pack under explicit operator trust.
 *
 * It hashes the pack's manifest and entry files, signs the canonical statement
 * `{"entries":{…},"manifestSha256":…,"pack":…,"version":…}` (keys sorted, no
 * whitespace) with an Ed25519 key YOU hold, and prints the JSON array to set as
 * the env value. The private key never leaves your machine and is never printed;
 * no conformance signing key is distributed (RFC 0238 §D.1).
 *
 *   node scripts/ui-plugin-operator-trust.mjs \
 *     --pack core.openwop.conformance.ui-plugin-narrow \
 *     --tenant <the conformance tenant> \
 *     --key ~/.openwop-keys/ui-plugin-operator.pem       # created 0600 if absent
 *     [--dir conformance-fixtures/frontend-plugin-packs]
 *
 * The host's verifier is `backend/typescript/src/features/ui-plugins/operatorTrustedPacks.ts`;
 * `test/adr0840-operator-trust-script.test.ts` runs this script and checks the host
 * accepts what it prints, so the two canonical forms cannot drift.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const fail = (m) => { process.stderr.write(`ui-plugin-operator-trust: ${m}\n`); process.exit(1); };
for (const k of ['pack', 'tenant', 'key']) if (!args[k]) fail(`--${k} is required`);
const dir = resolve(ROOT, args.dir ?? 'conformance-fixtures/frontend-plugin-packs');
if (!existsSync(dir)) fail(`no packs dir at ${dir} (sync the fixtures at a suite tag that carries RFC 0238)`);

const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v);
const sha = (b) => createHash('sha256').update(b).digest('hex');

let manifestBytes = null;
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const b = readFileSync(resolve(dir, f));
  try { const m = JSON.parse(b.toString('utf8')); if (m.kind === 'frontend-plugin' && m.name === args.pack) { manifestBytes = b; break; } } catch { /* skip */ }
}
if (!manifestBytes) fail(`no frontend-plugin manifest named ${args.pack} in ${dir}`);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const entries = {};
for (const p of manifest.uiPlugins ?? []) {
  const abs = resolve(dir, p.entry);
  if (!abs.startsWith(dir + sep)) fail(`entry ${p.entry} escapes ${dir}`);
  entries[p.entry] = sha(readFileSync(abs));
}

const keyPath = resolve(args.key.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
if (!existsSync(keyPath)) {
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  process.stderr.write(`created a new operator key at ${keyPath} (0600); keep it, never commit it\n`);
}
const privateKey = createPrivateKey(readFileSync(keyPath));
const statement = canonical({ pack: manifest.name, version: manifest.version, manifestSha256: sha(manifestBytes), entries });
const entry = {
  pack: manifest.name,
  tenant: args.tenant,
  publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
  signature: sign(null, Buffer.from(statement, 'utf8'), privateKey).toString('base64'),
};
process.stdout.write(`${JSON.stringify([entry])}\n`);
