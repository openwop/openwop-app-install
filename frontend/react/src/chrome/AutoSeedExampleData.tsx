import { useEffect } from 'react';
import { seedExampleAgents } from '../agents/rosterClient.js';
import { loadDemoMode } from '../client/demoMode.js';

let started = false;

/**
 * Auto-seed the demo roster once per page load — but ONLY on a demo deployment
 * (the host advertises `demoMode: true`). A clean / white-label install never
 * seeds behind the user's back: it starts empty, and demo data is loaded
 * explicitly from `/demo-data`. On the public demo, cookie-per-visitor tenancy
 * means any deep link can be a fresh anon tenant's first route, so the
 * idempotent seed runs from the shell (not just `/agents`).
 */
export function AutoSeedExampleData(): null {
  useEffect(() => {
    if (started) return;
    started = true;
    void (async () => {
      try {
        // Populates the app-wide demoMode cache (consumed by sample-content
        // gates elsewhere) and gates the silent auto-seed.
        if (!(await loadDemoMode())) return; // clean install — never auto-seed
        await seedExampleAgents();
      } catch (err) {
        console.warn('auto demo seed skipped/failed', err);
      }
    })();
  }, []);

  return null;
}
