#!/usr/bin/env node
/**
 * ADR 0825 — the host-event subscription census, taken before OPENWOP_HOST_EVENTS_V2 goes on.
 *
 * With the flag on, a MAJOR-2 webhook subscription receives a runless host event
 * (`host.crm.contact.created`, …) only when its `events[]` NAMES that type, and
 * the body becomes `{ hostEvent }` (RFC 0236). A `*` subscription stays
 * run-events-only, per the corpus guidance recorded in ADR 0825. So turning the
 * flag on changes delivery for exactly three groups, and this counts each one:
 *
 *   A. major-2 subs naming a host event: they KEEP receiving it, but the body
 *      shape changes from `{ runId, event }` to `{ hostEvent }`. These are the
 *      receivers to notify.
 *   B. major-2 subs whose `events[]` is `*` (or contains it): they STOP receiving
 *      host events. That is only a change for a `*` sub that actually consumed
 *      host events, which this cannot know, so they are counted for review.
 *   C. major-1 subs naming a host event: unchanged by the flag. Counted only
 *      because P3 (v1 deletion) will strand them.
 *
 * READ-ONLY. One connection, one SELECT of four columns (never the URL or the
 * secret), aggregates printed, and subscription ids only with `--ids`. It is a
 * script rather than a one-off query because the number gates a product
 * decision and must be reproducible by whoever makes it.
 *
 *   OPENWOP_STORAGE_DSN=postgres://… node scripts/host-event-subscription-census.mjs [--ids]
 */
import { createRequire } from 'node:module';
const backendRequire = createRequire(new URL('../backend/typescript/package.json', import.meta.url));
const pg = backendRequire('pg');

const DSN = process.env.OPENWOP_STORAGE_DSN ?? process.env.DATABASE_URL;
if (!DSN || !/^postgres/.test(DSN)) {
  console.error('host-event-subscription-census: set OPENWOP_STORAGE_DSN to a postgres DSN.');
  console.error('  READ-ONLY: one connection, one SELECT of (subscription_id, tenant_id, protocol_major, events).');
  process.exit(2);
}
const showIds = process.argv.includes('--ids');

/**
 * Is a subscription's `events[]` entry a HOST event name? This covers every
 * spelling this host has ever accepted:
 * - the in-process `host.<feature>.<verb>` (ADR 0208);
 * - the three-segment v2 vendor spelling (`openwop-app.crm.contact-created`,
 *   ADR 0792), whose prefix is the HOST_EVENT_ORG in host/hostEventNames.ts;
 * - the two-segment RFC 0236 spelling (`openwop-app.crm-contact-created`).
 * Some `openwop-app.*` names are run-event vendor types, so the two `openwop-app.`
 * forms are reported in a separate column and never folded into a single total.
 */
const isHostDotted = (e) => typeof e === 'string' && e.startsWith('host.');
const isVendorHost = (e) => typeof e === 'string' && e.startsWith('openwop-app.');

const client = new pg.Client({ connectionString: DSN, application_name: 'host-event-subscription-census' });
await client.connect();
try {
  const { rows } = await client.query(
    'SELECT subscription_id, tenant_id, protocol_major, events FROM webhooks',
  );
  const tally = {
    total: rows.length,
    major1: 0, major2: 0,
    A_major2_names_host_dotted: 0, A_major2_names_openwop_app_vendor: 0,
    B_major2_wildcard: 0,
    C_major1_names_host_event: 0,
  };
  const tenants = { A: new Set(), B: new Set(), C: new Set() };
  const ids = { A: [], B: [], C: [] };
  for (const r of rows) {
    const major = r.protocol_major === 2 ? 2 : 1; // NULL = a pre-0723 row = major 1
    const events = Array.isArray(r.events) ? r.events : [];
    const dotted = events.some(isHostDotted);
    const vendor = events.some(isVendorHost);
    const wildcard = events.includes('*');
    if (major === 2) {
      tally.major2 += 1;
      if (dotted) tally.A_major2_names_host_dotted += 1;
      if (vendor) tally.A_major2_names_openwop_app_vendor += 1;
      if (dotted || vendor) { tenants.A.add(r.tenant_id); ids.A.push(r.subscription_id); }
      if (wildcard) { tally.B_major2_wildcard += 1; tenants.B.add(r.tenant_id); ids.B.push(r.subscription_id); }
    } else {
      tally.major1 += 1;
      if (dotted || vendor) { tally.C_major1_names_host_event += 1; tenants.C.add(r.tenant_id); ids.C.push(r.subscription_id); }
    }
  }
  console.log(JSON.stringify({
    ...tally,
    tenants: { A: tenants.A.size, B: tenants.B.size, C: tenants.C.size },
    ...(showIds ? { ids } : {}),
  }, null, 2));
} finally {
  await client.end();
}
