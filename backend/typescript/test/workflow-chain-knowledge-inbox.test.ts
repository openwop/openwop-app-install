/**
 * Knowledge + Inbox workflow-chain packs (ADR 0190 Phase 2), plus the
 * repo-wide VENDORED-PACK CONVENTIONS suite.
 *
 * The conventions suite loads ONLY the in-tree root (never the registry
 * install dir / operator override — those are machine-local and third-party
 * packs never signed up for this host's conventions), then asserts over
 * EVERY vendored chain:
 *   1. every external SEND (email-send / slack-message / sms-send) sits
 *      behind ≥1 approval gate, and the chain is marked side-effectful
 *      (draft-only core.email.draft, in-app notification-push, and
 *      ticket-create are exempt — the it-support precedent);
 *   2. every declared parameter is live in some node config/inputs
 *      (expansion drops node `name` fields — the Phase 1 dead-param defect);
 *   3. expansion is deterministic and validated.
 * This codifies the ADR 0190 correction: market-intel/exec-ops chains with
 * no external send correctly carry no gate — the convention binds sends,
 * not side-effect markings.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowChainPacks,
  getChain,
  listChains,
  expandChain,
  chainRequirements,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// backend/typescript/test → repo root → the vendored (in-tree) pack root only.
const IN_TREE_ROOT = join(__dirname, '..', '..', '..', 'examples', 'workflow-chain-packs');

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: [IN_TREE_ROOT] });
  expect(errors).toEqual([]);
});

// ── Phase 2 packs ──

const PACKS: Record<string, string[]> = {
  'core.openwop.workflows.knowledge': [
    'knowledge.policy-qa',
    'knowledge.compliance-review',
    'knowledge.doc-summarizer',
  ],
  'core.openwop.workflows.inbox': [
    'inbox.triage',
    'inbox.followup-nudger',
    'inbox.call-debrief',
  ],
};
const PHASE2_CHAINS = Object.values(PACKS).flat();

/** The portability contract — every typeId must be a shipped/known node id. */
const KNOWN_TYPEIDS = new Set([
  'feature.kb.nodes.rag',
  'core.ai.chatCompletion',
  'core.chat.approvalGate',
  'core.flow.if',
  // WF-EM-1: the `falsy approved → noop` completion branch (ADR 0582 §10).
  'core.flow.noop',
  'core.email.draft',
  'core.openwop.integration.email-send',
  'core.openwop.integration.slack-message',
  'feature.notifications.nodes.notify',
]);

describe('knowledge + inbox packs — discovery', () => {
  it.each(Object.entries(PACKS))('%s loads all its chains', (pack, ids) => {
    for (const id of ids) {
      const entry = getChain(id);
      expect(entry, id).not.toBeNull();
      expect(entry!.packName).toBe(pack);
    }
    expect(listChains().filter((c) => c.packName === pack)).toHaveLength(ids.length);
  });

  it('gallery categories derive from the pack keywords', () => {
    expect(getChain('knowledge.policy-qa')!.category).toBe('Knowledge');
    expect(getChain('inbox.triage')!.category).toBe('Productivity');
  });
});

describe('knowledge + inbox packs — every node uses a known shipped typeId', () => {
  it.each(PHASE2_CHAINS)('%s references only registered typeIds', (id) => {
    const chain = getChain(id)!.chain;
    for (const n of chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });
});

describe('knowledge + inbox packs — expansion', () => {
  /**
   * WF-KB-16 — `knowledge.policy-qa` was expanded here with `{ question: … }`,
   * a param name the pack RENAMED to `query` (and the schema declares
   * `additionalProperties:false`). `expandChain` does not validate `required`,
   * so the determinism + single-primary assertions below ran against an
   * expansion in which ALL THREE required params went unsupplied — a state no
   * real instantiation produces. The `covers every required param` test below
   * is the ratchet that stops a future rename drifting the same way.
   */
  const sampleParams: Record<string, Record<string, unknown>> = {
    'knowledge.policy-qa': { query: 'How many PTO days roll over?', orgId: 'org:acme', collectionId: 'kbc:hr' },
    'knowledge.compliance-review': { documentText: 'We guarantee 100% uptime, forever.', query: 'uptime commitments', orgId: 'org:acme', collectionId: 'kbc:hr' },
    'knowledge.doc-summarizer': { documentText: 'Q3 plan: ship the connector suite…' },
    // The same drift the ratchet below was written for, found in the inbox
    // half on its first run: both chains declare required params these samples
    // never supplied, so their determinism assertions ran against an expansion
    // no real instantiation produces.
    'inbox.triage': { emailText: 'Subject: contract — can you send the signed copy today?', replyToAddress: 'ops@acme.test' },
    'inbox.followup-nudger': { threadText: 'Me (Jun 20): any thoughts on the proposal?', recipientEmail: 'buyer@acme.test', senderEmail: 'rep@acme.test' },
    'inbox.call-debrief': { transcript: 'Buyer: pricing feels high. Rep: compared to…' },
  };

  /**
   * WF-KB-15 — the primary output is the LAST TERMINAL IN DECLARATION ORDER
   * (`workflowChainPackLoader.ts:1090-1092`). Counting primaries (the previous
   * assertion) is satisfied by exactly one primary on the WRONG node, which is
   * how both routing chains shipped with the else-branch Slack escalation as
   * the declared result. Name the node.
   *
   * ADR 0643 D5 — this map is ALSO the (only available) enforcement of the
   * "declare the terminal, don't inherit authoring order" intent. The ADR asked
   * for an explicit `outputRole: "primary"` on the intended terminal in the
   * pack manifest; that is UNIMPLEMENTABLE on this host today and was verified
   * so rather than assumed: `FragmentNode` in
   * `schemas/workflow-chain-pack-manifest.schema.json` is
   * `additionalProperties: false` over `{id, typeId, name, position, config,
   * inputs, compensation, irreversibleEffect}`, so a pack carrying `outputRole`
   * fails manifest validation outright —
   * `workflow_chain_pack_manifest_invalid: … "additionalProperty":"outputRole"`
   * — and the WHOLE PACK stops loading. `expandChain` never reads an authored
   * `outputRole` either (`workflowChainPackLoader.ts:1379` writes it purely from
   * `primaryNodeId`). Adding the field is a vendored-spec (RFC 0013) change, not
   * host work. Until that lands, the reorder is caught HERE — so the map now
   * covers EVERY Phase-2 chain, not just the knowledge half, and the
   * completeness assertion below stops a new chain arriving unpinned.
   */
  const EXPECTED_PRIMARY: Record<string, string> = {
    'knowledge.policy-qa': 'deliver',
    'knowledge.compliance-review': 'pass',
    'knowledge.doc-summarizer': 'notify',
    // ADR 0643 D4 — `inbox.triage`'s single fan-in `notify` split into two
    // branch-owned notifies; the reply-drafted terminal is the declared product.
    'inbox.triage': 'notifyDrafted',
    'inbox.followup-nudger': 'send',
    'inbox.call-debrief': 'notify',
  };

  it.each(PHASE2_CHAINS)('%s expands to a validated, deterministic definition', (id) => {
    const chain = getChain(id)!.chain;
    const def = expandChain(chain, { params: sampleParams[id]! });
    expect(def.workflowId.startsWith(`${id}:`)).toBe(true);
    expect(def.nodes).toHaveLength(chain.dag.nodes.length);
    expect(def.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
    expect(expandChain(chain, { params: sampleParams[id]! })).toEqual(def);
  });

  it.each(PHASE2_CHAINS)('%s sample params cover every declared REQUIRED param', (id) => {
    const chain = getChain(id)!.chain;
    const required = ((chain.parameters as { required?: string[] }).required) ?? [];
    for (const name of required) {
      expect(Object.keys(sampleParams[id]!), `${id} sample params must supply required param "${name}"`).toContain(name);
    }
  });

  it.each(Object.entries(EXPECTED_PRIMARY))('%s stamps outputRole:primary on %s, the happy-path terminal', (id, shortId) => {
    const chain = getChain(id)!.chain;
    const def = expandChain(chain, { params: sampleParams[id]! });
    const primary = def.nodes.find((n) => n.outputRole === 'primary');
    expect(primary, `${id} must declare exactly one primary`).toBeTruthy();
    expect(primary!.nodeId.endsWith(`_${shortId}`), `${id} primary is ${primary!.nodeId}, expected …_${shortId}`).toBe(true);
  });

  /** A pin nothing enumerates is a pin a new chain walks past. */
  it('every Phase-2 chain has its primary terminal pinned by name', () => {
    expect(Object.keys(EXPECTED_PRIMARY).sort()).toEqual([...PHASE2_CHAINS].sort());
  });

  /**
   * WF-KB-5 — the class no format check policed: a node whose implementation
   * reads a named input port that NOTHING binds. Scoped to the knowledge pack's
   * three delivery sinks (the corpus-wide version is `WF-KB-6`, deliberately
   * measured-before-enforced per ADR 0504's lesson). A bare edge lands the whole
   * upstream map on `input`, so the port must be named by an edge's target or by
   * an authored `inputs` key.
   */
  const REQUIRED_INPUT_PORTS: Record<string, string> = {
    'feature.notifications.nodes.notify': 'message',
    'core.chat.approvalGate': 'artifact',
    'core.openwop.integration.slack-message': 'text',
  };

  it.each(PHASE2_CHAINS)('%s binds every delivery node\'s content port', (id) => {
    const chain = getChain(id)!.chain;
    for (const node of chain.dag.nodes) {
      const port = REQUIRED_INPUT_PORTS[node.typeId];
      if (!port) continue;
      const authored = Object.keys((node.inputs ?? {}) as Record<string, unknown>);
      const bound = (chain.dag.edges ?? []).some((e) => e.to === `${node.id}.${port}`);
      expect(
        bound || authored.includes(port),
        `${id}:${node.id} (${node.typeId}) reads inputs.${port}, which no edge targets and no literal supplies — a bare edge would land it on the default 'input' port and the node would deliver an EMPTY ${port}`,
      ).toBe(true);
    }
  });

  it('draft-only chains contain no real send node', () => {
    for (const id of ['inbox.triage']) {
      const chain = getChain(id)!.chain;
      expect(chain.dag.nodes.some((n) => n.typeId === 'core.email.draft')).toBe(true);
      expect(chain.dag.nodes.some((n) => n.typeId === 'core.openwop.integration.email-send')).toBe(false);
    }
  });
});

// ── Repo-wide vendored-pack conventions (ADR 0190) ──

const GATED_SINKS = new Set([
  'core.openwop.integration.email-send',
  'core.openwop.integration.slack-message',
  'core.openwop.integration.sms-send',
]);

// ADR 0200 — a connector WRITE (core.openwop.http.openapi-call whose operationId
// is a write verb) is an external side-effect that MUST be gated, exactly like a
// send. `openapi-call` is dual-use (read=ungated, write=gated), so classify by the
// operationId verb prefix — the OpenAPI convention people-hr already follows
// (createUser/disableUser gated; listCalendarEvents read-through). Conservative:
// only KNOWN write verbs count, so an ambiguously-named read never false-trips.
const WRITE_VERB = /^(create|update|upsert|delete|remove|disable|deactivate|patch|put|post|write|send|archive|cancel)/i;
function isConnectorWrite(node: { typeId: string; config?: Record<string, unknown> }): boolean {
  if (node.typeId !== 'core.openwop.http.openapi-call') return false;
  const op = node.config?.operationId;
  return typeof op === 'string' && WRITE_VERB.test(op);
}

describe('vendored packs — repo-wide conventions', () => {
  it('loads a non-trivial vendored catalog', () => {
    expect(listChains().length).toBeGreaterThanOrEqual(30);
  });

  // WF-EM-4 — a PRECONDITION, not the gating guarantee: `approvalGateCount`
  // counts gate NODES, and ten chains that mailed a contact on a REJECT passed
  // it. The behavioural witness (real gate handler + real UI payloads + real
  // scheduler) is `workflow-chain-email-reject-witness.test.ts`.
  it('every vendored chain DECLARES an approval-gate node for its external sends and connector writes', () => {
    for (const { chain } of listChains()) {
      const sendsExternally = chain.dag.nodes.some((n) => GATED_SINKS.has(n.typeId) || isConnectorWrite(n));
      if (!sendsExternally) continue;
      const req = chainRequirements(chain, new Set(chain.dag.nodes.map((n) => n.typeId)), () => true);
      expect(req.approvalGateCount, `${chain.chainId} sends/writes externally without a gate`).toBeGreaterThanOrEqual(1);
      expect(chain.capabilities ?? [], `${chain.chainId} sends/writes externally but is not side-effectful`).toContain('side-effectful');
    }
  });

  it('every declared parameter in every vendored chain is live in config/inputs', () => {
    for (const { chain } of listChains()) {
      const configText = JSON.stringify(chain.dag.nodes.map((n) => ({ c: n.config, i: n.inputs })));
      const params = Object.keys(
        ((chain.parameters as { properties?: Record<string, unknown> }).properties) ?? {},
      );
      for (const name of params) {
        expect(configText.includes(`{{params.${name}}}`), `${chain.chainId} param ${name} is dead`).toBe(true);
      }
    }
  });
});
