/**
 * ADR 0551 P2 — the boot readiness check the RFC 0059 workspace advertisement
 * now depends on.
 *
 * P0 moved the workspace out of a module `Map` and into `Storage`. That closed
 * the implementation gap but not the ADVERTISEMENT gap: `routes/discovery.ts`
 * still claimed `workspace.supported: true` unconditionally, including on a
 * `memory://` boot where the store is a `:memory:` sqlite database that dies
 * with the process. `spec/v1/agent-workspace.md` §9 makes the workspace snapshot
 * a cross-host replay guarantee — "a run replayed on another host MUST observe
 * the same workspace snapshot" — and a store that does not outlive its own
 * process cannot be read by any other process, ever. So on that profile the
 * capability is genuinely absent, and saying so is the only honest option.
 *
 * ── WHY THE GATE IS `storageDurability()` AND NOT A NEW CONCEPT ─────────────
 *
 * ADR 0551's P2 row says "production posture fails closed if workspace is
 * requested with memory storage". ADR 0555 CORRECTION 4 already established
 * that **there is no deployment-posture concept in this codebase** and that
 * inventing one produces a gate nobody enables — i.e. a gate that cannot fail.
 * The fact the row is actually about is the SELECTED STORAGE ADAPTER, which
 * `storage/index.ts` `storageDurability(dsn)` already answers, at the only place
 * that can (`memory://` resolves to the sqlite backend at `:memory:`, so the
 * adapter TYPE cannot answer it). That helper was written by P0 with no consumer
 * in `src/`, waiting for exactly this phase.
 *
 * ── TWO DURABILITY PREDICATES, AND WHY THAT IS NOT A SECOND OWNER ──────────
 *
 * `deployPosture.ts` `isDurableStorageDsn()` is STRICTER — Postgres only — and
 * answers a different question: "is this control plane durable for a
 * MULTI-INSTANCE deployment", where a sqlite file on stateless compute dies with
 * the container. This one answers "does the store outlive the process at all",
 * which is the floor the workspace advert claims. They are layered, not
 * competing: under `OPENWOP_DEPLOY_POSTURE=auth` the DUR-1 guard already refuses
 * a sqlite DSN outright, so a real deploy never reaches the weaker line. A
 * developer on `sqlite://./data/app.db` gets a workspace that genuinely survives
 * restart and is genuinely readable by a second process pointed at the same
 * file, which is what §9 asks of the STORE.
 *
 * ── FAIL CLOSED, BUT AT THE RIGHT THING ────────────────────────────────────
 *
 * Refusing to BOOT every `memory://` dev box and test run would be hostile and,
 * worse, would make this gate something people route around. So the default is:
 * the capability is ABSENT and one warn line says why. An operator who requires
 * the workspace sets `OPENWOP_WORKSPACE_REQUIRE_DURABLE=true`, and then a
 * non-durable DSN is a fatal misconfiguration at server start — the same shape,
 * and the same server-only placement, as `enterprisePostureStartupError`
 * (`main()`, never `createApp()`: the suite boots in-process apps on `memory://`
 * by design and must not pay deployment guards).
 *
 * The workspace ROUTES are deliberately NOT gated. They keep working on
 * `memory://` because they are the thing under test; what is withheld is the
 * CLAIM, which is the only part that was ever untrue.
 */

import { storageDurability } from '../storage/index.js';

/** Env flag: this deployment REQUIRES a durable workspace, so a non-durable
 *  storage DSN is a fatal misconfiguration rather than a withheld capability. */
export function workspaceDurabilityRequired(): boolean {
  return process.env.OPENWOP_WORKSPACE_REQUIRE_DURABLE === 'true';
}

/**
 * Is the RFC 0059 workspace capability advertisable on this boot?
 *
 * The single predicate `routes/discovery.ts` calls. Nothing else decides this —
 * a second caller re-deriving it from the adapter instance would be
 * re-implementing DSN semantics, which is the drift `storageDurability`'s own
 * header warns about.
 */
export function workspaceAdvertisable(storageDsn: string): boolean {
  return storageDurability(storageDsn) === 'durable';
}

/**
 * The one warn line a non-durable boot emits, or `null` when the workspace is
 * advertisable. Returned rather than logged so it is a pure function a test can
 * assert on — a guard whose only evidence is a log line is a guard nobody can
 * prove fired.
 */
export function workspaceReadinessWarning(storageDsn: string): string | null {
  if (workspaceAdvertisable(storageDsn)) return null;
  return (
    `RFC 0059 workspace is NOT advertised: OPENWOP_STORAGE_DSN is ` +
    `'${storageDsn.split('://')[0]}://…', whose store does not outlive this process. ` +
    `spec/v1/agent-workspace.md §9 requires that a run replayed on another host observe ` +
    `the same workspace snapshot, which no process-local store can provide. The workspace ` +
    `ENDPOINTS still work here; only the capability claim is withheld. Point ` +
    `OPENWOP_STORAGE_DSN at sqlite://<file> or Postgres to advertise it, and set ` +
    `OPENWOP_WORKSPACE_REQUIRE_DURABLE=true to make this a fatal misconfiguration instead.`
  );
}

/**
 * Server-start guard. Returns the fatal misconfiguration message when this
 * deployment REQUIRES a durable workspace and the selected adapter cannot
 * provide one; `null` otherwise.
 *
 * Called from `main()` only, for the same reason `enterprisePostureStartupError`
 * is: in-process test apps run `memory://` deliberately.
 */
export function workspaceReadinessStartupError(storageDsn: string): string | null {
  if (!workspaceDurabilityRequired()) return null;
  if (workspaceAdvertisable(storageDsn)) return null;
  return (
    `OPENWOP_WORKSPACE_REQUIRE_DURABLE=true requires a durable workspace store, but ` +
    `OPENWOP_STORAGE_DSN is '${storageDsn.split('://')[0]}://…' — the RFC 0059 file store ` +
    `would die with this process, so the cross-host replay snapshot spec/v1/agent-workspace.md §9 ` +
    `guarantees is unreachable. Point OPENWOP_STORAGE_DSN at sqlite://<file> or Postgres, or ` +
    `unset OPENWOP_WORKSPACE_REQUIRE_DURABLE to run without the capability advertised.`
  );
}
