/**
 * Demo-deployment switch (host extension).
 *
 * `OPENWOP_DEMO_MODE` distinguishes the public SHOWCASE deployment
 * (app.openwop.dev) from a clean / white-label install:
 *
 *   - OFF (default): production-grade out of the gate. NO automatic seeding,
 *     NO synthetic showcase fallback — every surface reads only the tenant's
 *     own real data. Empty stays empty (with explicit "Load demo data").
 *   - ON: the reference demo. Boot-seeds the read-only `__showcase__` tenant
 *     and lets the workforce dashboards fall back to it so an anonymous visitor
 *     sees populated screens — but the responses are tagged so the UI can BADGE
 *     that data as illustrative (never passes synthetic numbers off as real).
 *
 * This is the master gate for everything AUTOMATIC. Explicit, user-triggered
 * seeding (the `/demo-data` dashboard) stays available regardless, governed by
 * {@link exampleDataSeedEnabled} in `exampleDataSeed.ts` — a clean install can still opt in to
 * load demo data, it just never happens behind the user's back.
 */
export function demoMode(): boolean {
  return process.env.OPENWOP_DEMO_MODE === 'true';
}
