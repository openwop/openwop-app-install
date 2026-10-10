/**
 * UI-plugins feature routes (host-extension, non-normative paths; ADR 0300).
 * Backs the front-end `PluginFrame` loader that mounts a downloaded
 * `kind:"frontend-plugin"` pack in a cross-origin sandboxed iframe (RFC 0117/0119).
 *
 *   GET  /v1/host/openwop-app/ui-plugin/packs
 *        → the installed plugins the host HONORS (surface/hostApi ∩ advertised set)
 *          plus the host's advertised `isolation` (the FE loader reads this so the
 *          mechanism it applies can't drift from the advert — RFC 0119 non-drift).
 *   GET  /v1/host/openwop-app/ui-plugin/packs/:name/plugins/:pluginId/entry
 *        → the plugin's `entry` bytes (size-capped, traversal-safe), served under a
 *          deny-egress CSP header as defense-in-depth. (ADR 0840: the FE now mounts
 *          the per-plugin `frame` by iframe `src`; the header policy is load-bearing.)
 *   POST /v1/host/openwop-app/ui-plugin/demo-artifact
 *        → ensures a per-tenant demo canvas so the reference artifact-viewer plugin
 *          has a real target to `artifact.read` over ui-plugin/1 (tenant-scoped).
 *
 * The ui-plugin/1 dispatcher is owned by the core `routes/uiPlugins.ts` module; this
 * feature serves it ONLY per plugin (RFC 0238 `…/host/ui-plugins/{pack}/{plugin}/rpc`).
 * ADR 0840 D7 deleted the host-global vendor RPC route and its v1 conformance alias.
 */

import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { tenantOf } from '../featureRoute.js';
import { markUiPluginOperationsServed, pluginFrameCsp, pluginIframeCsp, uiPluginsCapability } from '../../host/uiPluginRpc.js';
import { presentationEnabled } from '../../host/hostProfile.js';
import { requireProtocolScope } from '../../host/protocolAuthorization.js';
import { dispatchForPlugin } from '../../routes/uiPlugins.js';
import { ISOLATION_PROBE_HTML } from '../../host/uiPluginIsolationProbe.js';
import type { Response } from 'express';
import { createHash } from 'node:crypto';

/** ADR 0840 — the ONE way this host sends a plugin frame document: the policy in
 *  the header (RFC 0238 §B), never a meta tag. The isolation probe goes out the
 *  same way, so the self-test exercises the delivery real plugins get. */
function sendPluginFrame(res: Response, html: Buffer | string, connectSrc: readonly string[] = []): void {
  res.set('Content-Security-Policy', pluginFrameCsp(connectSrc));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  res.type('text/html; charset=utf-8').send(html);
}
import { ensureCanvasForTenant } from '../../host/canvasSurface.js';
import { listFrontendPluginPacks, getPluginEntry, hostIsolation, resolveTrustCandidate, operatorTrustTenant } from './frontendPluginPacks.js';
import { UI_PLUGIN_FIXTURE_ARTIFACT, UI_PLUGIN_FIXTURE_PACK } from './operatorTrustedPacks.js';
import { verifyPinned, verifyDetachedPinned, loadPinnedKeyring } from '../../host/packSignature.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { registerToggleDefault } from '../../host/featureToggles/registry.js';

const BASE = '/host/openwop-app/ui-plugin';
/** The demo canvas the reference artifact-viewer reads (per-tenant, provisioned on demand). */
// Canvas ids are global keys, so the demo artifact's id is derived from the tenant:
// one fixed id would make each tenant's call take the previous tenant's canvas.
const demoArtifactId = (tenantId: string): string =>
  `ui-plugin-demo-${createHash('sha256').update(tenantId).digest('hex').slice(0, 24)}`;
const DEMO_CANVAS_TYPE = 'canvas.app-builder';

export function registerUiPluginsFeatureRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ADR 0367 P2 — the trusted-lane KILL SWITCH: a second toggle owned by this
  // feature, registered with its routes (the commerce-ucp precedent). Default
  // OFF: absent an admin decision, NO pack ever loads main-frame.
  registerToggleDefault({
    id: 'trusted-plugins',
    label: 'Trusted plugins (signed, full access)',
    description: 'Serve operator-pinned, Ed25519-signed plugin packs into the main frame with full UI integration. Signature + revocation re-verified at every serve. Off = every pack stays in the sandbox.',
    category: 'Developer',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'trusted-plugins',
  });

  // The plugins the host serves + the advertised isolation mechanism (single source).
  app.get(`${BASE}/packs`, async (req, res, next) => {
    try {
      // ADR 0367 P2 — tier labeling. A plugin is labeled 'trusted' only when the
      // label is TRUE RIGHT NOW: the kill-switch toggle is on AND the full pinned
      // verification (manifest + module bytes) passes with the current keyring.
      // Lane off or any verification miss ⇒ 'community' — the label always tells
      // the FE which mount path will actually succeed, never an aspiration.
      const gate = await resolveOne('trusted-plugins', { tenantId: tenantOf(req) });
      const keyring = gate?.enabled ? loadPinnedKeyring() : null;
      const listed = listFrontendPluginPacks();
      const plugins = listed.map((pl) => {
        if (!keyring) return { ...pl, tier: 'community' as const };
        const cand = resolveTrustCandidate(pl.packName, pl.pluginId, listed);
        const trusted = cand !== null
          && verifyPinned(cand.packDir, cand.manifest, keyring) === 'trusted'
          && verifyDetachedPinned(cand.moduleBytes, cand.moduleSignature, cand.manifest.signing.keyId, keyring);
        return trusted
          ? { ...pl, tier: 'trusted' as const, trustedEntryPath: `${BASE}/trusted/${encodeURIComponent(pl.packName)}/plugins/${encodeURIComponent(pl.pluginId)}/entry.mjs` }
          : { ...pl, tier: 'community' as const };
      });
      res.json({ isolation: hostIsolation(), plugins });
    } catch (err) { next(err); }
  });

  // The entry bundle bytes — mounted by the FE loader via srcdoc. Deny-egress CSP as
  // defense-in-depth; the load-bearing egress denial is the srcdoc's own CSP (FE
  // `withPluginCsp`) + the opaque-origin sandbox the FE applies. NOTE: on the
  // `app.openwop.dev/api/**` path this response header is overridden by Firebase
  // Hosting's global app CSP — the `firebase.json` entry-path rule (ADR 0300) re-asserts
  // deny-egress there so the defense-in-depth holds end-to-end (this header is
  // authoritative on the direct Cloud Run origin). Uniform 404 on any miss (no leak).
  app.get(`${BASE}/packs/:name/plugins/:pluginId/entry`, (req, res, next) => {
    try {
      const entry = getPluginEntry(req.params.name, req.params.pluginId);
      if (!entry) throw new OpenwopError('not_found', 'Unknown plugin entry.', 404, {});
      res.set('Content-Security-Policy', pluginIframeCsp());
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'public, max-age=300');
      res.type(entry.contentType).send(entry.bytes);
    } catch (err) { next(err); }
  });

  // ADR 0367 P2 — the TRUSTED lane: an openwop-team-SIGNED pack's entry served
  // as a same-origin ES module for MAIN-FRAME dynamic import. The signature +
  // revocation are re-verified AT EVERY SERVE against the operator-held
  // keyring (never pack-supplied keys — host/packSignature.verifyPinned), and
  // the 'trusted-plugins' kill-switch toggle gates the whole lane. Every
  // failure path is a uniform 404 (toggle off / unsigned / unknown key /
  // tampered / revoked) — no tier leak, no fallback-to-sandbox surprises at
  // this route (the FE falls back by using the sandbox lane it already has).
  app.get(`${BASE}/trusted/:name/plugins/:pluginId/entry.mjs`, async (req, res, next) => {
    try {
      const gate = await resolveOne('trusted-plugins', { tenantId: tenantOf(req) });
      if (!gate?.enabled) throw new OpenwopError('not_found', 'Unknown plugin entry.', 404, {});
      const cand = resolveTrustCandidate(req.params.name, req.params.pluginId);
      if (!cand) throw new OpenwopError('not_found', 'Unknown plugin entry.', 404, {});
      const keyring = loadPinnedKeyring();
      if (verifyPinned(cand.packDir, cand.manifest, keyring) !== 'trusted') {
        throw new OpenwopError('not_found', 'Unknown plugin entry.', 404, {});
      }
      // The manifest signature vouches for identity+version; this one vouches for
      // the exact CODE served into the main frame. Both must hold.
      if (!verifyDetachedPinned(cand.moduleBytes, cand.moduleSignature, cand.manifest.signing.keyId, keyring)) {
        throw new OpenwopError('not_found', 'Unknown plugin entry.', 404, {});
      }
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, max-age=60'); // short: revocation must bite quickly
      res.type('text/javascript').send(cand.moduleBytes);
    } catch (err) { next(err); }
  });

  // ── ADR 0840 (RFC 0238) — the normative observation path ──────────────────
  // Registered under `/v1` because the negotiator rewrites every major-2 protocol
  // request (and, per ADR 0840, every browser load of a document operation) onto it.
  // A host without the facet, or a plugin it does not serve, answers 404 to both.
  const servedPlugin = (packName: string, pluginId: string) =>
    presentationEnabled('uiPlugins')
      ? listFrontendPluginPacks().find((p) => p.packName === packName && p.pluginId === pluginId) ?? null
      : null;

  // §B — the document the plugin runs in, its isolation and egress in the header.
  // The SPA mounts plugins only from here (`framePath` in the listing above).
  app.get('/host/ui-plugins/:packName/:pluginId/frame', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'manifest:read');
      const plugin = servedPlugin(req.params.packName as string, req.params.pluginId as string);
      const entry = plugin ? getPluginEntry(plugin.packName, plugin.pluginId) : null;
      if (!plugin || !entry) throw new OpenwopError('not_found', 'Unknown plugin.', 404, {});
      sendPluginFrame(res, entry.bytes, plugin.connectSrc);
    } catch (err) { next(err); }
  });

  // ADR 0493 / ADR 0840 — the isolation self-test's probe, delivered exactly as a
  // plugin frame is (header policy, mounted by `src`). Vendor path: not a protocol op.
  app.get(`${BASE}/isolation-probe`, (_req, res, next) => {
    try {
      if (!presentationEnabled('uiPlugins')) throw new OpenwopError('not_found', 'Not found.', 404, {});
      sendPluginFrame(res, ISOLATION_PROBE_HTML);
    } catch (err) { next(err); }
  });

  // §C — the plugin's ui-plugin/1 calls, allowlisted to ITS hostApi (manifest ∩ host).
  app.post('/host/ui-plugins/:packName/:pluginId/rpc', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'artifacts:read');
      const plugin = servedPlugin(req.params.packName as string, req.params.pluginId as string);
      if (!plugin) throw new OpenwopError('not_found', 'Unknown plugin.', 404, {});
      // ADR 0840 D6 (RFC 0238 §D.2) — the fixture's artifact, in the tenant the
      // operator installed the fixture for: an owner-less app-builder canvas whose
      // content references the BYOK canary WITHOUT resolving it. Idempotent; only
      // for that pack and that tenant, so trust in the fixture writes nothing else.
      const fixtureTenant = plugin.packName === UI_PLUGIN_FIXTURE_PACK && operatorTrustTenant(plugin.packName) === tenantOf(req);
      if (fixtureTenant) {
        await ensureCanvasForTenant(tenantOf(req), UI_PLUGIN_FIXTURE_ARTIFACT, {
          canvasTypeId: DEMO_CANVAS_TYPE,
          initialState: { title: 'RFC 0238 fixture artifact', credentialRef: '{{secrets.openwop-conformance-canary-secret}}' },
        });
      }
      res.json(await dispatchForPlugin(req, new Set<string>(plugin.hostApi), fixtureTenant ? UI_PLUGIN_FIXTURE_ARTIFACT : undefined));
    } catch (err) { next(err); }
  });
  markUiPluginOperationsServed();

  // A real artifact for the viewer to read over ui-plugin/1 (tenant-scoped, idempotent).
  app.post(`${BASE}/demo-artifact`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const canvas = await ensureCanvasForTenant(tenantId, demoArtifactId(tenantId), {
        canvasTypeId: DEMO_CANVAS_TYPE,
        initialState: {
          title: 'UI-plugin demo artifact',
          note: 'Read by community.openwop.artifact-viewer over ui-plugin/1 (artifact.read).',
          host: { isolation: uiPluginsCapability().isolation, surfaces: uiPluginsCapability().surfaces },
        },
      });
      res.json({ artifactId: canvas.canvasId, version: String(canvas.version) });
    } catch (err) { next(err); }
  });
}
