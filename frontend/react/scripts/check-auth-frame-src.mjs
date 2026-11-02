#!/usr/bin/env node
/**
 * check-auth-frame-src (ADR 1021 D9) — build gate. The rules, and why, are in
 * `authFrameSrc.mjs`. The auth domain is read the way Vite reads it for a
 * production build (`loadEnv`), so an adopter's own env files and process env
 * are what count.
 */
import { readFileSync } from 'node:fs';
import { loadEnv } from 'vite';
import { appFrameSrc, authFrameSrcFindings } from './authFrameSrc.mjs';

const authDomain = loadEnv('production', process.cwd(), 'VITE_').VITE_FIREBASE_AUTH_DOMAIN;
let text;
try { text = readFileSync('../../firebase.json', 'utf8'); } catch {
  console.log('✓ check-auth-frame-src: no firebase.json (not a Firebase Hosting deploy), skipped.');
  process.exit(0);
}
const frameSrc = appFrameSrc(text);
if (frameSrc === null) {
  console.log('✓ check-auth-frame-src: the app CSP sets no frame-src (it falls back to default-src), skipped.');
  process.exit(0);
}
const findings = authFrameSrcFindings(authDomain, frameSrc);
if (findings.length > 0) {
  console.error(`✗ check-auth-frame-src (ADR 1021):\n${findings.map((f) => `  - ${f}`).join('\n')}\n  Edit the app-wide Content-Security-Policy in firebase.json.`);
  process.exit(1);
}
console.log(`✓ check-auth-frame-src: frame-src admits the auth domain (${authDomain || 'none configured'}) with no Firebase wildcard.`);
