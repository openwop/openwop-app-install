/**
 * ADR 0812 P3c-0 — the major-1 discovery document, read from its builder.
 *
 * Once major 1 retires, a header-less `GET /.well-known/openwop` is the CLOSED
 * v2 root (`buildV2Advertisement`), which deliberately carries only the families
 * this host can state exactly (`routes/discovery.ts`, "WHY IT IS SHORT"). Several
 * host claims a test pins — `artifactTypes`, `anonymousActor`,
 * `hostExtensions.featureSurfaces`, the `capabilities` wrapper — have no v2 record
 * yet, so the wire no longer carries them in that mode. The v1 builder is still
 * live code (the operations attestation digests it, `features/operations/routes.ts`),
 * so a test that pins one of those claims reads it HERE, which answers the same
 * in both modes. A claim that HAS a v2 home is asserted on the v2 root instead.
 *
 * Call after `createApp()` has run: the builder reads the live registries
 * (feature surfaces, artifact types) the boot populated.
 *
 * THIS IS DEBT, NOT A HOME (ADR 0858). Every caller pins a claim that a
 * v1-retired host no longer puts on the wire: it proves the host still COMPUTES
 * the claim, not that clients can see it. ADR 0858 P3/P4 re-points each caller
 * at its v2 record once projected, or deletes the leg into that ADR's ledger
 * with a reason. ADR 0812 P3c deletes `buildAdvertisement`, so this file cannot
 * outlive that work: the fold does not compile while any caller remains.
 */
import type { AppConfig } from '../../src/index.js';

export async function v1Advertisement(config?: AppConfig): Promise<Record<string, any>> {
  const { buildAdvertisement } = await import('../../src/routes/discovery.js');
  const { loadConfigFromEnv } = await import('../../src/index.js');
  return buildAdvertisement(config ?? loadConfigFromEnv()) as Record<string, any>;
}
