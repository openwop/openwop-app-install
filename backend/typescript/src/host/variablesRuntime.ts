/**
 * Variables runtime — in-process per-run variable bag for the
 * workflow-engine sample.
 *
 * Per `spec/v1/workflow-definition.schema.json §variables` and the
 * `conformance-identity` fixture contract (per
 * `conformance/fixtures.md §conformance-identity`): a workflow
 * declares `variables[]` with optional `defaultValue`. At run-create
 * time, the variable bag is seeded from those defaults, with
 * `POST /v1/runs.inputs` overriding by variable name. Runtime nodes
 * MAY read/mutate variables (full mid-run mutation surface is future
 * scope — see HVMAP-2 in `aiEnvelope.contractRefusal` family).
 *
 * Snapshot surface: `GET /v1/runs/{runId}` returns
 * `RunSnapshot.variables: { [name]: value }` so the conformance
 * suite can assert "what went in comes back out."
 *
 * DURABILITY (ENG-3): the in-process Map is a write-through CACHE in front of
 * the kv Storage. `seedRunVariables` / `setRunVariable` persist the run's bag,
 * and `hydrateRunVariables(runId)` reloads it — the executor calls hydrate
 * before executing a run, so a run re-dispatched by the sweeper on ANOTHER
 * instance recovers its variable bag instead of running with an empty one.
 * When storage isn't wired (a unit test without host-ext init) it degrades to
 * in-memory-only, exactly as before.
 */

import { tryDurableStorage } from './durable/durableStore.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.variablesRuntime');

interface VariableDecl {
  readonly name: string;
  readonly defaultValue?: unknown;
}

const runVariables = new Map<string, Map<string, unknown>>();

const KEY_PREFIX = 'runvars:';
const key = (runId: string): string => `${KEY_PREFIX}${runId}`;

/** Write-through the whole bag for `runId` to durable storage (fire-and-forget;
 *  the bags are small). No-op when storage isn't wired. */
function persistBag(runId: string): void {
  const storage = tryDurableStorage();
  if (!storage) return;
  const bag = runVariables.get(runId);
  const obj = bag ? Object.fromEntries(bag.entries()) : {};
  void storage.kvSet(key(runId), JSON.stringify(obj)).catch((err) => {
    log.warn('run_variables_persist_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * Load a run's variable bag from durable storage into the in-memory cache —
 * the executor calls this before executing a (possibly re-dispatched) run so
 * variables survive a cross-instance hand-off (ENG-3). A run already in the
 * cache is left as-is (the live bag wins). No-op without storage.
 */
export async function hydrateRunVariables(runId: string): Promise<void> {
  if (runVariables.has(runId)) return;
  const storage = tryDurableStorage();
  if (!storage) return;
  try {
    const raw = await storage.kvGet(key(runId));
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    runVariables.set(runId, new Map(Object.entries(obj)));
  } catch (err) {
    log.warn('run_variables_hydrate_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Build the initial variable bag for a new run. `variableDecls` comes
 * from `workflow.variables[]`; `inputs` is `POST /v1/runs.inputs`
 * (typically an object keyed by variable name, but the function
 * tolerates non-object inputs by treating them as "no overrides").
 *
 * Precedence: `inputs[name]` (if present) > `defaultValue` (if
 * declared) > omitted. Variables without an input override AND
 * without a default are not seeded — the read surface returns
 * `undefined` for them, which `JSON.stringify` collapses to "key
 * absent." Callers that need a stricter "MUST seed" contract
 * should validate via the workflow's inputSchema before calling.
 */
export function seedRunVariables(
  runId: string,
  variableDecls: ReadonlyArray<VariableDecl> | undefined,
  inputs: unknown,
): void {
  const bag = new Map<string, unknown>();
  const inputsObj =
    inputs && typeof inputs === 'object' && !Array.isArray(inputs)
      ? (inputs as Record<string, unknown>)
      : undefined;
  for (const decl of variableDecls ?? []) {
    if (!decl || typeof decl.name !== 'string' || decl.name.length === 0) continue;
    if (inputsObj && Object.prototype.hasOwnProperty.call(inputsObj, decl.name)) {
      bag.set(decl.name, inputsObj[decl.name]);
    } else if ('defaultValue' in decl) {
      bag.set(decl.name, decl.defaultValue);
    }
    // else: absent — caller's inputSchema validation decides whether
    // that's an error. The runtime doesn't gate on `required`.
  }
  runVariables.set(runId, bag);
  persistBag(runId);
}

/**
 * Snapshot the variable bag for `runId` as a plain object. Returns
 * `null` if no bag exists (the run was never seeded — e.g., the
 * sample's older code path on a fixture without `variables[]`).
 * Snapshot-shape callers should use `undefined` collapse on the
 * `RunSnapshot.variables` field when this returns null.
 */
export function snapshotRunVariables(runId: string): Record<string, unknown> | null {
  const bag = runVariables.get(runId);
  if (!bag) return null;
  return Object.fromEntries(bag.entries());
}

/**
 * Set a single variable. Future scope (HVMAP-2 mid-run mutation seam)
 * will expose this via a `POST /v1/host/openwop-app/test/runs/:runId/
 * variables` endpoint; today only the suite-init seeding path uses
 * it (via `seedRunVariables`).
 */
export function setRunVariable(runId: string, name: string, value: unknown): void {
  let bag = runVariables.get(runId);
  if (!bag) {
    bag = new Map<string, unknown>();
    runVariables.set(runId, bag);
  }
  bag.set(name, value);
  persistBag(runId);
}

/** Drop the bag for `runId` — used by tenant-hard-delete cascades
 *  and the test-seam reset. Safe to call on absent runIds. */
export function clearRunVariables(runId: string): void {
  runVariables.delete(runId);
  const storage = tryDurableStorage();
  if (storage) {
    void storage.kvDelete(key(runId)).catch((err) => {
      log.warn('run_variables_delete_failed', { runId, error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/** Test-only: drop EVERY bag. Suite teardown uses this to keep state
 *  from leaking across scenarios. */
export function __resetAllRunVariablesForTests(): void {
  runVariables.clear();
}
