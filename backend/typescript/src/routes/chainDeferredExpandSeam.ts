/**
 * RFC 0124 (WCP4) — conformance witness seam for the deferred-parameter mode.
 *
 * `@openwop/openwop-conformance`'s `workflow-chain-deferred-parameters.test.ts`
 * capability-gated host legs (gated on `workflowChainPacks.deferredParameters.
 * supported`, which this host advertises) POST `/v1/host/sample/chain/deferred-expand`
 * to witness the deferred pipeline NON-VACUOUSLY on a live host. Absent the seam the
 * legs soft-skip on a 404; serving it makes them exercise the REAL pipeline:
 *
 *   expandChain({deferred})  →  materialize {{params.x}} into top-level variables[]
 *                               (source:"variable"; source:"secret" for
 *                               x-openwop-sensitive) + a minted PromptTemplate
 *   deferredConfigurableInputs → a BARE-PARAM `override` rebinds the value per run
 *   (frozen def is byte-stable) → a `:fork` replays the same bound value (R4)
 *   composePromptTemplate      → the deferred prompt binding composes
 *                               contentTrust:"untrusted" (R1); a sensitive
 *                               source:"secret" var resolves via BYOK and REDACTS
 *                               to [REDACTED:<credentialRef>] (SR-1) — plaintext
 *                               never appears.
 *
 * The two conformance chains are host-synthesized in-handler (openwop-1's decision
 * (i) on crosstalk `f475`: RFC 0124 has one chain-compose witness today, so there is
 * no cross-host parity to protect yet; publishing them as fixtures is the upgrade
 * path if a second chain-compose host appears). This is the SAME compose function
 * (`composePromptTemplate`) the dispatch node uses — a genuine witness, not a mock.
 *
 * Seam-gated on OPENWOP_TEST_SEAM_ENABLED (404s in prod), mirroring
 * `routes/dispatchFanOut.ts`. Registered BEFORE testSeam.ts's catch-all
 * sample→openwop-app rewrite.
 */

import type { Express, Request, Response } from 'express';
import { expandChain, type WorkflowChain } from '../host/workflowChainPackLoader.js';
import { deferredConfigurableInputs } from '../host/variablesRuntime.js';
import { composePromptTemplate, type PromptTemplate } from '../host/promptCompose.js';
import { setSecret } from '../byok/secretResolver.js';
import { sendError } from '../middleware/errorEnvelope.js';

const SEAM_PATH = '/v1/host/sample/chain/deferred-expand';
const TENANT = 'conformance';

/** Non-sensitive deferred chain: one `topic` param used in a prompt body →
 *  materializes as a `source:"variable"` deferred variable. */
function deferredChain(topicDefault: string): WorkflowChain {
  return {
    chainId: 'conformance.deferred',
    version: '1.0.0',
    label: 'Conformance deferred',
    description: 'RFC 0124 deferred-parameter witness (non-sensitive).',
    parameters: {
      type: 'object',
      required: ['topic'],
      properties: { topic: { type: 'string', default: topicDefault } },
    },
    dag: {
      nodes: [
        {
          id: 'compose',
          typeId: 'local.sample.demo.mock-ai',
          config: { systemPrompt: '{{params.topic}}' },
        },
      ],
    },
  } as unknown as WorkflowChain;
}

/** Sensitive deferred chain: one `x-openwop-sensitive` `apiKey` param in a prompt
 *  body → materializes as a `source:"secret"` deferred variable (BYOK + redaction). */
function deferredSensitiveChain(): WorkflowChain {
  return {
    chainId: 'conformance.deferred-sensitive',
    version: '1.0.0',
    label: 'Conformance deferred (sensitive)',
    description: 'RFC 0124 deferred-parameter witness (source:secret).',
    parameters: {
      type: 'object',
      required: ['apiKey'],
      properties: { apiKey: { type: 'string', 'x-openwop-sensitive': true } },
    },
    dag: {
      nodes: [
        {
          id: 'compose',
          typeId: 'local.sample.demo.mock-ai',
          config: { systemPrompt: 'Authed by {{params.apiKey}}.' },
        },
      ],
    },
  } as unknown as WorkflowChain;
}

type DefMeta = {
  deferredParameterAliases?: Record<string, string>;
  mintedPromptTemplates?: PromptTemplate[];
};

function metaOf(def: { metadata?: Record<string, unknown> }): DefMeta {
  return (def.metadata ?? {}) as DefMeta;
}

function bindingTrustFor(template: PromptTemplate): Record<string, 'trusted' | 'untrusted'> {
  const trust: Record<string, 'trusted' | 'untrusted'> = {};
  for (const v of template.variables ?? []) {
    if (v.source === 'variable') trust[v.name] = 'untrusted';
  }
  return trust;
}

async function handle(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as {
    chainId?: string;
    params?: Record<string, unknown>;
    override?: Record<string, unknown>;
    fork?: boolean;
    sensitiveParam?: string;
    credentialRef?: string;
    // RFC 0136 B1 witness — an INLINE chain whose `variables[]` (with any minted
    // `format`) the caller reads back. Additive to the `chainId` cases below.
    chain?: { parameters?: unknown; dag?: unknown };
    values?: Record<string, unknown>;
  };

  try {
    // RFC 0136 §Conformance B1 — deferred-mode chain-parameter `format` propagation.
    // Expand an INLINE chain in deferred mode and return its materialized
    // `variables[]` with names de-prefixed to the bare parameter name (the key the
    // caller passed). `format` is present IFF the host minted it: on a STRING param
    // that declared a `format` (copied verbatim, unknown values included — req 2/7),
    // and ABSENT on a non-string param (req 1) or a string param with no `format`.
    // This is `expandChain({deferred})` — the same materialization the editor and
    // from-chain use — not a mock. `format` is never carried into `configurableSchema`
    // (req 8), so it can never become a run-rejection path (req 3).
    if (body.chain && typeof body.chain === 'object') {
      const rawParams = body.chain.parameters as
        | { type?: string; properties?: Record<string, unknown>; required?: string[] }
        | Record<string, unknown>
        | undefined;
      // Accept either a full parameters object ({type,properties,required}) or a
      // bare properties map; normalize to the former.
      const parameters =
        rawParams && typeof rawParams === 'object' && 'properties' in rawParams
          ? (rawParams as { type?: string; properties?: Record<string, unknown>; required?: string[] })
          : { type: 'object', properties: (rawParams as Record<string, unknown>) ?? {} };
      const dag =
        body.chain.dag && typeof body.chain.dag === 'object'
          ? (body.chain.dag as WorkflowChain['dag'])
          : { nodes: [{ id: 'n1', typeId: 'core.identity', config: {} }], edges: [] };
      const inlineChain = {
        chainId: 'conformance.inline-format',
        version: '1.0.0',
        label: 'Conformance inline (RFC 0136 format witness)',
        description: 'RFC 0136 deferred-mode format-propagation witness (inline chain).',
        parameters,
        dag,
      } as unknown as WorkflowChain;

      const def = expandChain(inlineChain, { deferred: true, params: body.values ?? {} });
      const aliases = metaOf(def).deferredParameterAliases ?? {};
      const mintedToBare: Record<string, string> = {};
      for (const [bare, minted] of Object.entries(aliases)) mintedToBare[minted] = bare;

      const variables = (def.variables ?? []).map((v) => ({
        name: mintedToBare[v.name] ?? v.name, // bare param name (produced vars keep their name)
        ...(v.type !== undefined ? { type: v.type } : {}),
        ...(v.format !== undefined ? { format: v.format } : {}), // present IFF minted
        required: v.required ?? false,
        ...(v.sensitive ? { sensitive: true } : {}),
      }));
      res.status(200).json({ variables });
      return;
    }

    if (body.chainId === 'conformance.deferred') {
      // 1. Deferred expansion — `topic` materializes into a source:"variable" var
      //    + a minted PromptTemplate; the frozen def is byte-stable.
      const topicDefault =
        typeof body.params?.topic === 'string' ? (body.params.topic as string) : 'default-topic';
      const def = expandChain(deferredChain(topicDefault), {
        deferred: true,
        params: { topic: topicDefault },
      });
      const meta = metaOf(def);
      const template = meta.mintedPromptTemplates?.[0];
      const topicVar = meta.deferredParameterAliases?.topic;
      if (!template || !topicVar) {
        sendError(res, 500, 'internal_error', 'deferred materialization produced no minted template');
        return;
      }

      // 2. Bare-param `override` rebinds the value for THIS run (config wins over default).
      const overrideTopic =
        typeof body.override?.topic === 'string' ? (body.override.topic as string) : topicDefault;
      const bag = deferredConfigurableInputs(def, { topic: overrideTopic }, undefined) as Record<string, unknown>;

      // 3. Compose the minted template resolving the deferred variable from the bag —
      //    the REAL compose path (contentTrust:"untrusted" for a deferred var, R1).
      const payload = await composePromptTemplate({
        templateId: template.templateId,
        template,
        bindings: bag,
        bindingTrust: bindingTrustFor(template),
        observability: 'full',
        nodeId: 'conformance-deferred',
        secretScope: { tenantId: TENANT },
      });

      // 4. `:fork` replays the SAME frozen def + configurable → byte-stable bound value (R4).
      const forkBag = body.fork
        ? (deferredConfigurableInputs(def, { topic: overrideTopic }, undefined) as Record<string, unknown>)
        : bag;

      res.status(200).json({
        resolved: bag[topicVar],
        forkResolved: forkBag[topicVar],
        contentTrust: payload.contentTrust,
      });
      return;
    }

    if (body.chainId === 'conformance.deferred-sensitive') {
      // A sensitive param → source:"secret" var; per-run supply is a credentialRef.
      const credentialRef =
        typeof body.credentialRef === 'string' && body.credentialRef.length > 0
          ? body.credentialRef
          : 'cred-conformance';
      // Provision the referenced secret (BYOK) so the compose resolves it + redacts.
      await setSecret(credentialRef, `conformance-plaintext-${Math.random().toString(36).slice(2, 10)}`, {
        tenantId: TENANT,
      });

      const def = expandChain(deferredSensitiveChain(), { deferred: true, params: { apiKey: 'placeholder' } });
      const meta = metaOf(def);
      const template = meta.mintedPromptTemplates?.[0];
      const apiKeyVar = meta.deferredParameterAliases?.apiKey;
      if (!template || !apiKeyVar) {
        sendError(res, 500, 'internal_error', 'sensitive materialization produced no minted template');
        return;
      }

      // Bind the sensitive var to the credentialRef (a reference, never plaintext).
      const bag = deferredConfigurableInputs(def, { apiKey: credentialRef }, undefined) as Record<string, unknown>;
      const payload = await composePromptTemplate({
        templateId: template.templateId,
        template,
        bindings: bag,
        bindingTrust: bindingTrustFor(template),
        observability: 'full',
        nodeId: 'conformance-deferred-sensitive',
        secretScope: { tenantId: TENANT },
      });

      res.status(200).json({ composed: payload.composed });
      return;
    }

    sendError(res, 404, 'chain_not_found', `unknown conformance chainId: ${String(body.chainId)}`);
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
}

export function registerChainDeferredExpandSeamRoutes(app: Express): void {
  // Conformance witness seam — env-gated (404s in prod), registered BEFORE
  // testSeam.ts's catch-all sample→openwop-app rewrite.
  if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    app.post(SEAM_PATH, (req, res) => {
      void handle(req, res);
    });
  }
}
