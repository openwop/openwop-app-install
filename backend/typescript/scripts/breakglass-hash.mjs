#!/usr/bin/env node
// ADR 0389 P3 — mint a break-glass token + its env-var hash. Run:
//   node scripts/breakglass-hash.mjs
// Store the TOKEN in the operator vault; put the HASH in
// OPENWOP_BREAKGLASS_TOKEN_HASH. Re-run to rotate (re-arms single-use).
import { randomBytes, scryptSync } from 'node:crypto';
const token = randomBytes(32).toString('base64url');
const salt = randomBytes(16);
const hash = scryptSync(token, salt, 32, { N: 16384, r: 8, p: 1 });
console.log('TOKEN (store in your vault, shown once):');
console.log(`  ${token}`);
console.log('OPENWOP_BREAKGLASS_TOKEN_HASH:');
console.log(`  scrypt$${salt.toString('base64')}$${hash.toString('base64')}`);
