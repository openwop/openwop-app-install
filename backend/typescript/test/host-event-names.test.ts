/**
 * ADR 0792 (NP-V2-10) — the host-event v2 spelling rule, over EVERY name this
 * host can emit:
 *   1. each projects to a grammar-valid v2 vendor type under a REGISTERED org;
 *   2. the projection is INJECTIVE — two host events never share a v2 spelling
 *      (else a v2 subscriber cannot tell them apart).
 *
 * Names are gathered from every `host.*` string literal in src/, the CRM and KB
 * verb tables, and the frontend catalog. Template-built emitters (a `verb:
 * string` parameter) cannot be enumerated, so they are checked as FAMILIES: the
 * only way the mapping can collide is a three-segment `host.a.x-y` against a
 * four-segment `host.a.x.y` (or the family `host.a.x.*`), and that is asserted.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { v2HostEventType, hostEventTypeSpellings, isV2HostEventName, v2WireEventType, wireEventTypeSpellings } from '../src/host/hostEventNames.js';
import { CRM_EVENT_TYPES } from '../src/features/crm/emit.js';
import { KB_EVENT_TYPES } from '../src/features/kb/emit.js';
import { registeredOrgs } from '../src/host/specDeclaration.js';
import { hostEventTypeEntries } from '../src/host/hostEventTypes.js';
import { wireEventType } from '../src/storage/eventEra.js';

const SRC = join(__dirname, '..', 'src');
const VENDOR = /^(?!openwop\.)[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)?$/;
// Strings that start `host.` but are NOT host events (capabilities, loggers,
// UI-plugin RPC) — excluded by prefix, recorded here so the exclusion is visible.
const NOT_EVENTS = /^host\.(db|sample|openwop-app|forms\.contentPacks|collab|kanban\.assign|agent\.escalation|durable|announce|init)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) out.push(p);
  }
  return out;
}

const literal = new Set<string>();
const families = new Set<string>(); // `host.a.b` for a template `host.a.b.${…}`
const featureFamilies = new Set<string>(); // `host.a` for a template `host.a.${entity}.${verb}`
for (const f of walk(SRC)) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/['"`](host\.[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)?)['"`]/g)) literal.add(m[1]!);
  for (const m of text.matchAll(/`(host\.[a-z0-9-]+\.[a-z0-9-]+)\.\$\{/g)) families.add(m[1]!);
  // Entity-templated ONLY: another segment must follow the placeholder
  // (`host.crm.${entity}.${verb}`). `host.webinar.${phase}` templates the LAST
  // segment, so it can emit only three-segment names; counting it here flagged
  // its own names as colliding with themselves once the full catalog fed this
  // test (ADR 0825; the retired SPA list happened to omit the webinar names).
  for (const m of text.matchAll(/`(host\.[a-z0-9-]+)\.\$\{[^}]*\}\./g)) featureFamilies.add(m[1]!);
}
// ADR 0825 — the SPA's hand-kept list is retired; the backend SSOT is the catalog.
const catalog = hostEventTypeEntries().map((e) => e.emitted).filter((n) => n.startsWith('host.'));
const names = [...new Set([...literal, ...CRM_EVENT_TYPES, ...KB_EVENT_TYPES, ...catalog, 'crm.segment.entered'])]
  .filter((n) => !NOT_EVENTS.test(n) && n !== 'host.webhook.response'); // P3: a RUN event, mapped in eventEra

describe('host-event v2 spelling (ADR 0792)', () => {
  it('is non-vacuous — the scan finds the host event population', () => {
    expect(names.length).toBeGreaterThan(80);
    expect(families.size + featureFamilies.size, 'template-built emitter families').toBeGreaterThan(5);
  });

  it('maps the documented shapes', () => {
    expect(v2HostEventType('host.crm.contact.created')).toBe('openwop-app.crm.contact-created');
    expect(v2HostEventType('host.goals.evaluated')).toBe('openwop-app.goals.evaluated');
    expect(v2HostEventType('crm.segment.entered')).toBe('openwop-app.crm.segment-entered');
    expect(v2HostEventType('openwop-app.crm.contact-triaged')).toBe('openwop-app.crm.contact-triaged');
    expect(v2HostEventType('run.completed')).toBeNull();
    expect([...hostEventTypeSpellings('host.crm.deal.won')].sort()).toEqual(['host.crm.deal.won', 'openwop-app.crm.deal-won']);
    expect([...hostEventTypeSpellings('run.completed')]).toEqual(['run.completed']);
    expect(isV2HostEventName('openwop-app.crm.contact-created')).toBe(true);
    expect(isV2HostEventName('openwop-app.a.b.c')).toBe(false);
  });

  it('the run-event codemap wins over the host rule (review of ADR 0792)', () => {
    // host.webhook.response is a RUN event with a HOST_VENDOR_ROWS row; a v2
    // webhook must say what a v2 poll says, and match no spurious third spelling.
    expect(v2WireEventType('host.webhook.response')).toBe('openwop-app.webhook-response');
    expect([...wireEventTypeSpellings('host.webhook.response')].sort()).toEqual(['host.webhook.response', 'openwop-app.webhook-response']);
    // A host event with no codemap row takes the host rule.
    expect(v2WireEventType('host.crm.contact.created')).toBe('openwop-app.crm.contact-created');
    // A protocol run event is untouched by the host rule.
    expect(v2WireEventType('run.completed')).toBe(wireEventType('run.completed', 2));
  });

  it('every emitted name projects to a v2-valid type under a registered org', () => {
    const orgs = registeredOrgs();
    const bad = names.flatMap((n) => {
      const v2 = v2HostEventType(n);
      if (v2 === null) return [`${n} → null`];
      if (!VENDOR.test(v2)) return [`${n} → ${v2} (grammar)`];
      if (!orgs.has(v2.slice(0, v2.indexOf('.')))) return [`${n} → ${v2} (unregistered org)`];
      return [];
    });
    expect(bad).toEqual([]);
  });

  it('is injective over every emitted name', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const n of names) {
      const v2 = v2HostEventType(n)!;
      const prior = seen.get(v2);
      if (prior !== undefined && prior !== n) collisions.push(`${prior} & ${n} → ${v2}`);
      seen.set(v2, n);
    }
    expect(collisions).toEqual([]);
  });

  it('the entity-templated family scan finds exactly the seven entity-templated emitters (non-vacuity)', () => {
    expect([...featureFamilies].sort()).toEqual(
      ['host.commission', 'host.crm', 'host.dealer', 'host.kb', 'host.priority', 'host.strategy', 'host.territory'],
    );
  });

  it('no three-segment name can collide with a template-built family', () => {
    const threeSeg = names.filter((n) => n.startsWith('host.') && n.split('.').length === 3);
    const hits = threeSeg.flatMap((n) => {
      const [, a, x] = n.split('.') as [string, string, string];
      // host.a.x-y would collide with host.a.x.y — i.e. with the family host.a.x.
      return x.split("-").slice(0, -1).map((_, i) => `host.${a}.${x.split('-').slice(0, i + 1).join('-')}`)
        .filter((fam) => families.has(fam))
        .map((fam) => `${n} vs family ${fam}.*`)
        // A feature that templates its ENTITY can emit any host.a.<e>.<v>, so a
        // three-segment name under it could collide with some member: forbid it.
        .concat(featureFamilies.has(`host.${a}`) ? [`${n} vs entity-templated family host.${a}.*.*`] : []);
    });
    expect(hits).toEqual([]);
  });
});
