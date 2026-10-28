/**
 * ADR 0942 D6 — which action class a node's effect belongs to, for every node a
 * Campaign Studio chain can reach whose manifest role is `side-effect` or
 * `action` (or that has no pack manifest at all and is not a gate).
 *
 * `PackNode` is closed (`additionalProperties:false`), so an `actionClass` field on
 * the node manifest would be a wire change; this host table is the precedent of
 * `approvalGateTypeIds.ts` and the side-effect floor. It is for DISPLAY and
 * PRE-GATING (the builder palette, the ADR 0960 cockpit). Enforcement never trusts
 * it: every effect chokepoint resolves the policy itself with real facts (D5).
 *
 * - an `ActionClass` — the node causes that class of effect;
 * - `'none'` — internal work with no campaign action class (the reason says why);
 * - `'refused'` — the node egresses outside a chokepoint, so no campaign chain may
 *   contain it (closes G5 for the program; ADR 0941 P4 adds `adapterOnly`).
 *
 * The ratchet (`test/adr0942-p2-action-classes.test.ts`) walks the campaign chain
 * packs through the real loader and fails on any such node without an entry.
 */
import type { ActionClass } from './types.js';

export interface ActionClassEntry {
  class: ActionClass | 'none' | 'refused';
  why: string;
}

export const NODE_ACTION_CLASSES: Readonly<Record<string, ActionClassEntry>> = Object.freeze({
  // ── model / media generation: drafts, never external ──
  'feature.campaign-brief.nodes.generate-kernel': { class: 'creative.generate', why: 'Generates the messaging kernel draft.' },
  'feature.campaign-brief.nodes.extract-voc': { class: 'creative.generate', why: 'Model extraction of voice-of-customer from sources; a draft.' },
  'feature.campaign-brief.nodes.build-targeting': { class: 'creative.generate', why: 'Model-built targeting draft.' },
  'feature.campaign-brief.nodes.generate-angles': { class: 'creative.generate', why: 'Model-generated creative angles; a draft.' },
  'feature.campaign-channels.nodes.generate': { class: 'creative.generate', why: 'Generates one channel\'s drafts.' },
  'feature.production.nodes.plan-generate': { class: 'creative.generate', why: 'Generates the production plan from the merged channels.' },
  // ── external effects ──
  'core.openwop.integration.email-send': { class: 'email.campaign-send', why: 'Sends marketing email from a journey step.' },
  'feature.campaign-journeys.nodes.send-sms': { class: 'sms.send', why: 'Sends one journey text to a person from the client\'s number (ADR 0955), an external effect; ctx.messaging.sendSms reaches the smsAdapter sms.send chokepoint, which resolves the policy itself.' },
  'feature.campaign-ops.nodes.execute': { class: 'campaign.change-set.apply', why: 'Applies an approved change set to the client\'s live destinations.' },
  'feature.campaign-connectors.nodes.push-catalog-feed': { class: 'ads.publish', why: 'ADR 0952 D6: publishes the client\'s product listings to Meta Catalog / Merchant Center, which can show publicly (Shopping free listings) and feed live shopping ads. catalogPushAdapter.pushCatalogItems passes the ads spend gate on ads.publish\'s PendingApproval lane (gateCatalogPublish, budget 0, content-hash keyed); the node waits on the approval. Its verified-writer gate (OPENWOP_ADS_VERIFIED_CATALOG_PUSH) still applies first.' },
  'feature.campaign-intel.nodes.apply-reallocation': { class: 'ads.budget', why: 'ADR 0952 D3: applies an approved reallocation plan; every op is adsAdapter.updateBudget, whose spend gate resolves the campaign policy itself (decreases first, caps re-checked on a current snapshot).' },
  // ── internal: no campaign action class ──
  'feature.campaign-autopilot.nodes.start-stage': { class: 'none', why: 'ADR 0961 starts an internal drafting stage with projected, frozen campaign decisions. Each child effect retains its own approval and spend chokepoint; this node grants no external authority.' },
  'feature.campaign-brief.nodes.validate': { class: 'none', why: 'Validates the brief; writes nothing outside it.' },
  'feature.campaign-orchestration.nodes.consistency-check': { class: 'none', why: 'Scores drafts against the kernel; a report.' },
  'feature.campaign-orchestration.nodes.finalize': { class: 'none', why: 'Writes the campaign row from the brief; nothing leaves the host.' },
  'feature.campaign-ops.nodes.interpret': { class: 'none', why: 'Interprets a change request into a proposal; nothing is applied.' },
  'feature.campaign-ops.nodes.propose': { class: 'none', why: 'Stores a proposed change set and asks for approval; nothing is applied.' },
  'feature.campaign-ops.nodes.mcp-campaign-list': { class: 'none', why: 'ADR 0962 read tool for an outside agent; reads one client\'s data, writes only the run\'s client stamp.' },
  'feature.campaign-ops.nodes.mcp-campaign-get': { class: 'none', why: 'ADR 0962 read tool for an outside agent; reads one client\'s data, writes only the run\'s client stamp.' },
  'feature.campaign-ops.nodes.mcp-campaign-performance': { class: 'none', why: 'ADR 0962 read tool for an outside agent; reads one client\'s data, writes only the run\'s client stamp.' },
  'feature.campaign-ops.nodes.mcp-pending-gates': { class: 'none', why: 'ADR 0962 read tool for an outside agent; reads one client\'s data, writes only the run\'s client stamp.' },
  'feature.campaign-ops.nodes.mcp-run-status': { class: 'none', why: 'ADR 0962 read tool for an outside agent; reads one client\'s data, writes only the run\'s client stamp.' },
  'feature.campaign-ops.nodes.mcp-explain': { class: 'none', why: 'ADR 0962 read tool for an outside agent; reads one client\'s data, writes only the run\'s client stamp.' },
  'feature.campaign-ops.nodes.mcp-request-change': { class: 'none', why: 'ADR 0962 request tool: writes a change request and starts the change-request chain; the change itself is campaign.change-set.apply, behind its approval.' },
  'feature.campaign-connectors.nodes.sync': { class: 'none', why: 'Reads platform metrics into the host.' },
  'feature.campaign-connectors.nodes.dispatch-conversions': { class: 'none', why: 'Uploads consented server-side conversions to ad platforms (ADR 0907); no campaign action class — gated by its own sub-toggle and per-row consent.' },
  'feature.campaign-intel.nodes.pacing-check': { class: 'none', why: 'Reads spend pacing; writes a memo.' },
  'feature.campaign-intel.nodes.enforce-caps': { class: 'none', why: 'Pauses breached or stale spend caps through the ads adapter; safety tightening never launches delivery or raises spend.' },
  'feature.campaign-intel.nodes.budget-optimize': { class: 'none', why: 'Read-only, confirmed from the code: the node calls surface.optimizeBudget, which reads the performance store and runs the pure optimizeBudget(records); the optional narrative is a model call. It writes no platform, no budget row and no plan; a recommendation reaches a budget only through propose-reallocation\'s approval and apply-reallocation (ads.budget).' },
  'feature.campaign-intel.nodes.propose-reallocation': { class: 'none', why: 'ADR 0952 D3: stores a reallocation plan and opens ONE campaign-spend approval over it; no budget changes. The apply is ads.budget.' },

  'feature.campaign-journeys.nodes.enroll': { class: 'none', why: 'Enrolls a contact into a journey; the sends are separate steps.' },
  'feature.crm.nodes.create-task': { class: 'none', why: 'Creates an internal CRM task.' },
  'feature.notifications.nodes.notify': { class: 'none', why: 'Notifies workspace members in-app.' },
  'core.flow.wait': { class: 'none', why: 'A timed wait.' },
  'feature.campaign-journeys.nodes.send-time': { class: 'none', why: 'Picks the contact\'s send time from their own engagement history (ADR 0955 P3) and waits for it as a durable timer; the send is a separate step.' },
  'feature.campaign-orchestration.nodes.autonomy-digest': { class: 'none', why: 'Sends the daily digest of notify-after steps to workspace members in-app (ADR 0942 D7); no campaign effect.' },
  'core.openwop.mcp.expose-tool': { class: 'none', why: 'Declares an MCP tool; the head of a read-tool chain, no effect.' },
  'core.dispatch': { class: 'none', why: 'Fans out child runs; children inherit the campaign stamps through the sub-workflow dispatcher.' },
  'core.orchestrator.supervisor': { class: 'none', why: 'Emits a dispatch plan; no effect.' },
  // ── refused: egress outside a chokepoint (G5) ──
  // typeIds of the `vendor.myndhyve.ads-publish-*` packs.
  'ads.publish.meta': { class: 'refused', why: 'vendor.myndhyve.ads-publish-meta: publishes ads with its own credentials and net.outbound, bypassing the adsAdapter spend chokepoint.' },
  'ads.publish.google': { class: 'refused', why: 'vendor.myndhyve.ads-publish-google: publishes ads outside the adsAdapter spend chokepoint.' },
  'ads.publish.tiktok': { class: 'refused', why: 'vendor.myndhyve.ads-publish-tiktok: publishes ads outside the adsAdapter spend chokepoint.' },
});

/** The table entry for a typeId (a `@version` suffix is ignored). */
export function actionClassOf(typeId: string): ActionClassEntry | undefined {
  return NODE_ACTION_CLASSES[typeId.replace(/@.*$/, '')];
}
