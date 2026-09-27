import { useEffect } from 'react';
import { seedExampleAgents } from '../agents/rosterClient.js';
import { loadDemoMode } from '../client/demoMode.js';
import { onAuthChanged } from '../auth/firebase.js';

let started = false;

/**
 * Auto-seed the demo roster once per page load — but ONLY on a demo deployment
 * (the host advertises `demoMode: true`) AND only for an ANONYMOUS visitor.
 * A clean / white-label install never seeds behind the user's back: it starts
 * empty, and demo data is loaded explicitly from `/demo-data`. On the public
 * demo, cookie-per-visitor tenancy means any deep link can be a fresh anon
 * tenant's first route, so the idempotent seed runs from the shell (not just
 * `/agents`).
 *
 * ADR 0434 Phase 5 — the signed-in gate. This used to check `demoMode` ALONE,
 * so on `app.openwop.dev` a real signed-in user got demo personas written into
 * their own `user:<hash>` tenant behind their back. Demo seeding exists for
 * visitors evaluating the product, never for someone's actual account.
 *
 * The gate is driven by `onAuthChanged`, NOT by the synchronous `getCurrentUser`
 * cache: that cache is empty during the boot window, so a sync check would read
 * a signed-in user as anonymous and seed anyway — the exact race this component
 * runs inside. Firebase fires `onAuthStateChanged` only once the initial state
 * (including persistence restore) has settled, so its first emission is the
 * trustworthy answer.
 */
export function AutoSeedExampleData(): null {
  useEffect(() => {
    if (started) return;
    started = true;
    let decided = false;
    const unsubscribe = onAuthChanged((user) => {
      if (decided) return; // first settled emission decides; ignore later rotations
      decided = true;
      void (async () => {
        try {
          // Populates the app-wide demoMode cache (consumed by sample-content
          // gates elsewhere) and gates the silent auto-seed.
          if (!(await loadDemoMode())) return; // clean install — never auto-seed
          if (user) return; // signed in — never seed demo data into a real account
          await seedExampleAgents();
        } catch (err) {
          console.warn('auto demo seed skipped/failed', err);
        }
      })();
    });
    return () => { unsubscribe(); };
  }, []);

  return null;
}
