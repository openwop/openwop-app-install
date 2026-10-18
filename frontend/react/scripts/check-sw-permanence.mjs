#!/usr/bin/env node
/**
 * ADR 0873 D2 — the service-worker scripts are PERMANENT. Runs AFTER `vite build`.
 *
 * Browsers update an installed worker by refetching its script URL. On this
 * host a missing file is answered by the `**` rewrite with `200 text/html`, so
 * the update fails and the old worker keeps running indefinitely, with whatever
 * fetch handler it had. A build that ships without `sw.js` or `sw-push.js` would
 * wedge every installed client, and nothing at deploy time would say so.
 *
 * Fails if either file is missing from `dist/`, looks like HTML, or does not
 * parse as a classic script (what `navigator.serviceWorker.register` loads).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

export const PERMANENT_WORKER_SCRIPTS = ['sw.js', 'sw-push.js'];

/** Problems with the worker scripts in `distDir`; empty when all are fine. */
export function checkWorkerScripts(distDir) {
  const problems = [];
  for (const name of PERMANENT_WORKER_SCRIPTS) {
    const path = join(distDir, name);
    if (!existsSync(path)) { problems.push(`${name}: missing from ${distDir}`); continue; }
    const text = readFileSync(path, 'utf8');
    if (text.trim().length === 0) { problems.push(`${name}: empty`); continue; }
    if (/^\s*</.test(text)) { problems.push(`${name}: looks like HTML, not JavaScript`); continue; }
    try {
      new Script(text, { filename: name });
    } catch (err) {
      problems.push(`${name}: does not parse as a script (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const problems = checkWorkerScripts('dist');
  if (problems.length > 0) {
    console.error('✗ check-sw-permanence (ADR 0873 D2): a deleted or broken worker script wedges installed clients');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`✓ check-sw-permanence: ${PERMANENT_WORKER_SCRIPTS.join(' + ')} present and parse as scripts`);
}
