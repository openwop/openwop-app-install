/**
 * ADR 0831 P2 — run-context providers: a core IoC seam that lets a feature add a
 * block of context to an agent turn on a run, without the agent runner importing
 * the feature (the `registerRunStartContributor` shape, on the read side).
 *
 * A provider returns ONE block of text that it has ALREADY FENCED through
 * `host/untrustedContent.ts`, or `undefined`. It MUST be deterministic for a given
 * run — read what the run was stamped with, never "latest" — so a replayed turn
 * builds the same prompt. Fail-soft: a throw is logged and contributes nothing.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runContextProviders');

export interface RunContextRequest { tenantId: string; runId: string }
export type RunContextProvider = (req: RunContextRequest) => Promise<string | undefined>;

const providers: Array<{ id: string; fn: RunContextProvider }> = [];

export function registerRunContextProvider(id: string, fn: RunContextProvider): void {
  if (providers.some((p) => p.id === id)) return; // idempotent across re-registration
  providers.push({ id, fn });
}

/** Every provider's block for this run, in registration order. */
export async function collectRunContextBlocks(req: RunContextRequest): Promise<string[]> {
  const out: string[] = [];
  for (const p of providers) {
    try {
      const block = await p.fn(req);
      if (block) out.push(block);
    } catch (err) {
      log.warn('run_context_provider_failed', { id: p.id, runId: req.runId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

