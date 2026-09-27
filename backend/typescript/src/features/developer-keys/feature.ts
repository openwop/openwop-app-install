/**
 * Developer API keys (ADR 0270 / CDP-H) — self-service scoped, rotatable bearer
 * tokens: issuance + management + the verification primitive (`verifyApiKey`).
 *
 * § Correction (ADR 0434) — graduated off its toggle to always-on.
 * The doc comment here previously said "wiring verification into
 * `middleware/auth.ts` is a separate, security-reviewed step" — that step has
 * since landed (`middleware/auth.ts`, the `owk_` bearer branch), which left the
 * toggle in an inconsistent and security-relevant half-open state: the VERIFIER
 * runs unconditionally in core auth, so keys already minted keep authenticating
 * when the toggle is flipped off — only the rotation/revocation UI disappears.
 * A switch that removes your ability to REVOKE a credential while the
 * credential keeps working is worse than no switch. `features/entities/routes.ts`
 * also imports `verifyApiKey` directly (without declaring `dependsOn`), so the
 * toggle graph could not see that coupling either.
 *
 * Graduating makes the surface honest: minting and revoking are always
 * reachable, exactly like the always-on Connections credential broker
 * (ADR 0024 § Correction — "a credential broker is platform plumbing, not an
 * optional product surface to A/B"). Authority is unchanged and is the real
 * gate: an authenticated principal is required to manage any key, and
 * `keyScopeOf` keeps self-service callers to their own keys while admin/owner
 * roles see the tenant's.
 *
 * @see docs/adr/0434-graduate-substrate-toggles.md
 */
import type { BackendFeature } from '../types.js';
import { registerDeveloperKeysRoutes } from './routes.js';

export const developerKeysFeature: BackendFeature = {
  id: 'developer-keys',
  registerRoutes: (deps) => {
    registerDeveloperKeysRoutes(deps);
  },
  // No toggleDefault — graduated off its toggle (§ Correction above).
};
