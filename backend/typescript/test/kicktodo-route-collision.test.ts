/**
 * ADR 0414 P1 — the KickTodo route-registration invariant (PRD §9.4):
 * every KickTodo package registers beneath the ONE collision-resistant owner
 * `/v1/host/openwop-app/kicktodo`, and no two KickTodo registrations claim the
 * same (method, path). Express keeps the FIRST registrant, so a collision is a
 * silently-dead route — this test makes it a loud failure instead.
 *
 * The check runs against `KICKTODO_ROUTES`, the same single source the app
 * mounts from (routes-as-data), so the test cannot drift from registration.
 * As later KickTodo packages (kicktodo-creator, …) land, their tables join the
 * `ALL_KICKTODO_ROUTE_TABLES` union below.
 */

import { describe, expect, it } from 'vitest';
import { KICKTODO_PREFIX, KICKTODO_ROUTES } from '../src/features/kicktodo-core/routes.js';
import { KICKTODO_CREATOR_ROUTES } from '../src/features/kicktodo-creator/routes.js';
import { KICKTODO_COMMERCE_ROUTES } from '../src/features/kicktodo-commerce/routes.js';
import { KICKTODO_CIRCLES_ROUTES } from '../src/features/kicktodo-accountability/routes.js';
import { KICKTODO_INTEGRATIONS_ROUTES } from '../src/features/kicktodo-integrations/routes.js';
import { KICKTODO_ENGAGEMENT_ROUTES } from '../src/features/kicktodo-engagement/routes.js';
import { KICKTODO_COMMUNITY_ROUTES } from '../src/features/kicktodo-community/routes.js';
import { KICKTODO_ORG_ROUTES } from '../src/features/kicktodo-organizations/routes.js';
import { KICKTODO_METRICS_ROUTES } from '../src/features/kicktodo-metrics/routes.js';

const ALL_KICKTODO_ROUTE_TABLES: ReadonlyArray<ReadonlyArray<{ method: string; path: string }>> = [
  KICKTODO_ROUTES,
  KICKTODO_CREATOR_ROUTES,
  KICKTODO_COMMERCE_ROUTES,
  KICKTODO_CIRCLES_ROUTES,
  KICKTODO_INTEGRATIONS_ROUTES,
  KICKTODO_ENGAGEMENT_ROUTES,
  KICKTODO_COMMUNITY_ROUTES,
  KICKTODO_ORG_ROUTES,
  KICKTODO_METRICS_ROUTES,
];

describe('KickTodo route-prefix invariants', () => {
  it('every route lives under the one collision-resistant prefix', () => {
    for (const table of ALL_KICKTODO_ROUTE_TABLES) {
      for (const r of table) {
        expect(r.path.startsWith(`${KICKTODO_PREFIX}/`), `${r.method.toUpperCase()} ${r.path} escapes the prefix`).toBe(true);
      }
    }
  });

  it('no two KickTodo registrations claim the same (method, path)', () => {
    const seen = new Map<string, string>();
    for (const table of ALL_KICKTODO_ROUTE_TABLES) {
      for (const r of table) {
        const key = `${r.method.toUpperCase()} ${r.path}`;
        expect(seen.has(key), `duplicate registration: ${key}`).toBe(false);
        seen.set(key, key);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('no KickTodo route shadows a reserved single-owner namespace', () => {
    // PRD §9.4 — KickTodo never registers a second /goals, /scheduler,
    // /notifications, /commerce, /billing, /marketplace, or /chat owner.
    const reserved = ['/goals', '/scheduler', '/notifications', '/commerce', '/billing', '/marketplace', '/chat'];
    for (const table of ALL_KICKTODO_ROUTE_TABLES) {
      for (const r of table) {
        const rest = r.path.slice(KICKTODO_PREFIX.length);
        expect(reserved.some((x) => rest === x || rest.startsWith(`${x}/`)), `${r.path} shadows a reserved owner`).toBe(false);
      }
    }
  });
});
