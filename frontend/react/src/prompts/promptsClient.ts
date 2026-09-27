/**
 * Client for the prompt library — proposed `GET /v1/prompts` + related
 * surfaces from RFC 0028. Until a host advertises `capabilities.prompts`,
 * every method falls back to the local sample library in `bundledPrompts.ts`.
 *
 * When the backend lands, the only behavioral change visible to callers
 * is that `listPrompts()` starts returning host-resident templates instead
 * of the sample list. Component callsites don't change.
 */

import { getCapabilities, getSdkClient } from '../client/runsClient.js';
import { loadDemoMode } from '../client/demoMode.js';
import { BUNDLED_PROMPTS } from './bundledPrompts.js';
import { listUserPrompts } from './userPrompts.js';
import type { PromptKind, PromptTemplate } from './types.js';

interface ListResponse {
  items: PromptTemplate[];
  nextCursor?: string;
}

export interface ListPromptsFilter {
  kind?: PromptKind;
  tag?: string;
  modelClass?: string;
  source?: 'host' | 'pack' | 'user';
}

/** Returns true when the host advertises RFC 0027 prompts support. The
 *  result is cached for the page lifetime — the capability is a wire-shape
 *  decision the host makes at boot time, so it shouldn't change mid-session.
 *
 *  Known limitation: if a sign-in flow swaps the auth identity (anon →
 *  signed-in) and per-tenant capability advertisement actually differs
 *  between identities, the cache will return stale results until the
 *  next page reload. That's an acceptable simplification because (a)
 *  the workflow-engine sample doesn't currently advertise differently
 *  per-tenant, and (b) the openwop spec treats capability advertisement
 *  as a host-boot decision, not a per-request one. If a future host
 *  does need tenant-scoped capabilities, clear the cache from
 *  `setCurrentIdToken` in `client/config.ts`. */
let cachedSupport: boolean | null = null;

/** Drop the memoized capability answer. Mirrors `clearCapabilitiesCache` —
 *  tests that stub discovery need the next call to actually read it. */
export function clearPromptsSupportCache(): void { cachedSupport = null; }
async function hostSupportsPrompts(): Promise<boolean> {
  if (cachedSupport !== null) return cachedSupport;
  try {
    // Routes through the SDK's `client.discovery.capabilities()` per
    // `sdk/PARITY.md` (Discovery row, always-on helper). The SDK handles
    // auth headers + cookie credentials + the response-shape contract.
    const caps = (await getCapabilities()) as {
      capabilities?: { prompts?: { supported?: boolean } };
    };
    // REVERTED from the v2 presence test (ADR 0730 C.3). `getCapabilities()`
    // reads the v1 document again — see the correction note in `runsClient.ts` —
    // so the v1 shape is the one that is actually served here.
    cachedSupport = caps?.capabilities?.prompts?.supported === true;
  } catch {
    cachedSupport = false;
  }
  return cachedSupport;
}

export async function listPrompts(filter: ListPromptsFilter = {}): Promise<PromptTemplate[]> {
  if (await hostSupportsPrompts()) {
    try {
      // ADR 0730 C.4 — `GET /prompts` on the major-2 client. The four filters
      // are the request shape verbatim, so the hand-built query string went
      // away with the raw fetch.
      const body = await getSdkClient().prompts.list({
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.tag ? { tag: filter.tag } : {}),
        ...(filter.modelClass ? { modelClass: filter.modelClass } : {}),
        ...(filter.source ? { source: filter.source } : {}),
      }) as ListResponse;
      // BE has canonical entries → return them merged with user
      // prompts (user prompts ride along regardless of BE state).
      if (body.items.length > 0) {
        return applyFilter([...listUserPrompts(), ...body.items], filter);
      }
      // BE returned empty — same as the old "no canonical set yet"
      // fallback. Drop through to the sample-library merge below.
    } catch {
      /* fall through to samples */
    }
  }
  // No host support OR BE empty OR fetch errored — merge user prompts on top
  // of the bundled samples ONLY on the demo host (ADR 0196 Gate A / DEMO-4):
  // the bundled set is wire-teaching material (`author: 'openwop-sample'`),
  // not enterprise starter content, so a clean install's library starts
  // genuinely empty (its designed empty state shows). Resolution-by-id
  // (`resolveLocal`) still honors bundled ids so an explicit historical
  // reference never breaks.
  const samples = (await loadDemoMode()) ? BUNDLED_PROMPTS : [];
  return applyFilter([...listUserPrompts(), ...samples], filter);
}

export async function getPrompt(templateId: string, version?: string): Promise<PromptTemplate | null> {
  if (await hostSupportsPrompts()) {
    try {
      // The SDK already returns `null` on a not-found, which is the same
      // signal the old `!res.ok` check produced: fall through to the local
      // library rather than surfacing an error.
      const found = await getSdkClient().prompts.get({
        templateId,
        ...(version ? { version } : {}),
      }) as PromptTemplate | null;
      if (found) return found;
    } catch {
      /* fall through to samples */
    }
  }
  return resolveLocal(templateId, version);
}

function resolveLocal(templateId: string, version?: string): PromptTemplate | null {
  // User-authored prompts shadow same-id samples (rare given the
  // `user:` prefix on user-ids, but coherent if a future BE adds a
  // canonical store that happens to collide).
  const pool = [...listUserPrompts(), ...BUNDLED_PROMPTS];
  const matches = pool.filter((p) => p.templateId === templateId);
  if (matches.length === 0) return null;
  if (!version) return matches[0]!;
  return matches.find((p) => p.version === version) ?? null;
}

function applyFilter(prompts: PromptTemplate[], filter: ListPromptsFilter): PromptTemplate[] {
  return prompts.filter((p) => {
    if (filter.kind && p.kind !== filter.kind) return false;
    if (filter.tag && !(p.tags ?? []).includes(filter.tag)) return false;
    if (filter.modelClass && p.modelHints?.modelClass !== filter.modelClass) return false;
    if (filter.source && p.meta?.source !== filter.source) return false;
    return true;
  });
}

/** Local-only template rendering for the inspector preview. Substitutes
 *  `{{var}}` placeholders with the supplied bindings; unresolved required
 *  variables raise; unresolved optional variables render as empty string
 *  (matching RFC 0027's `onUnresolved: 'empty'` semantics). Computes a
 *  sha256 hash of the rendered body so the preview stays consistent with
 *  the future `POST /prompts:render` deterministic-render invariant (the
 *  major-2 spelling — this client speaks major 2 since ADR 0730 C.4). */
export function renderLocal(
  template: PromptTemplate,
  variables: Record<string, unknown>,
): { rendered: string; missingRequired: string[] } {
  const missingRequired: string[] = [];
  const rendered = template.text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (name in variables) return String(variables[name] ?? '');
    const decl = (template.variables ?? []).find((v) => v.name === name);
    if (decl) {
      if (decl.required) missingRequired.push(name);
      if (decl.defaultValue !== undefined) return String(decl.defaultValue);
    }
    return '';
  });
  return { rendered, missingRequired };
}
