/**
 * chatSubmit — the ONE shared CORE submit pipeline for every chat surface
 * (ADR 0140 G1). Before this, the precedence chain was copied three ways
 * (`ChatSidebar`, `EmbeddedConversation`, `TabSession`) and drifted. The CORE is:
 *
 *   1. built-in `/command`  (registered commands win over same-name workflows)
 *   2. `/<slug>` workflow mention
 *   3. caller INTERCEPTORS (e.g. `@@` convene / board summon) — run BETWEEN workflow
 *      and the single `@` mention, so `@@board` is never read as `@board` and `/clear`
 *      is never shadowed
 *   4. `@<slug>` agent mention → activate + route
 *   5. send (with the caller's per-turn base options merged in)
 *
 * The full surface (`ChatSidebar`, and tabs post-G3) supplies the convene/board
 * interceptors; the embed and a plain tab pass none. Memoization stays with each
 * caller: this is a pure function they call inside their own `onUserSubmit`
 * `useCallback`, so each owns its dependency array (depend on the STABLE
 * `activeAgents` members, never the churning object).
 */

import { findCommand } from '../registry/CommandRegistry.js';
import { detectWorkflowSlashMention, type WorkflowMentionEntry } from './workflowMentions.js';
import { detectAgentMention, type AgentMentionEntry } from './agentMentions.js';
import { DEFAULT_ASSISTANT_ID } from '../activeAgents/constants.js';
import type { ContentPart, SendOptions } from '../hooks/useChatSession.js';
import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';

export interface CoreSubmitContext {
  config: BYOKActiveConfig;
  send: (text: string, config: BYOKActiveConfig, opts?: SendOptions) => Promise<void>;
  reset: () => void;
  cancel: () => Promise<void>;
  emitSystem: (text: string) => void;
  runWorkflowMention: (entry: WorkflowMentionEntry, trailing?: string) => Promise<void>;
  /** Only the CORE-needed members — callers pass their real `activeAgents`. */
  activeAgents: { activateAgent: (entry: AgentMentionEntry) => string; currentAgentId: string };
  agentEntries: readonly AgentMentionEntry[];
  /** Per-turn send options read at submit time (e.g. the full surface's web-search /
   *  model / tools toggles). Omit for the embed/plain-tab. */
  baseSendOptions?: () => Partial<SendOptions>;
  /** Fired when an `@`-mention activates an agent (e.g. persist it as a participant). */
  onAgentActivated?: (agentId: string) => void;
}

/** An interceptor runs after command/workflow, before the `@`-mention + send tail.
 *  - `{ kind: 'handled' }` — it owned the turn; stop.
 *  - `{ kind: 'route', activeAgentId?, boardSummoned? }` — continue to send, routed.
 *  - `null` — not mine; try the next. */
export type SubmitOutcome =
  | { kind: 'handled' }
  | { kind: 'route'; activeAgentId?: string; boardSummoned?: boolean }
  | null;

export type SubmitInterceptor = (
  text: string,
  attachments: readonly ContentPart[] | undefined,
  ctx: CoreSubmitContext,
) => Promise<SubmitOutcome>;

export async function runCoreSubmit(
  text: string,
  attachments: readonly ContentPart[] | undefined,
  ctx: CoreSubmitContext,
  interceptors: readonly SubmitInterceptor[] = [],
): Promise<void> {
  // 1. built-in slash command (wins over a same-slug workflow — `/clear` is sacred).
  if (!attachments) {
    const cmd = findCommand(text);
    if (cmd) {
      const consumed = await cmd.reg.handler(cmd.args, {
        send: (msg) => ctx.send(msg, ctx.config),
        reset: ctx.reset,
        cancel: ctx.cancel,
        config: ctx.config,
        emitSystem: ctx.emitSystem,
      });
      if (consumed) return;
    }
    // 2. `/<slug>` workflow mention.
    const slashMatch = detectWorkflowSlashMention(text);
    if (slashMatch) { await ctx.runWorkflowMention(slashMatch.entry, slashMatch.trailing ?? undefined); return; }
  }

  // 3. caller interceptors (convene/board), between workflow and the single `@`.
  let routedAgentId: string | undefined;
  let boardSummoned = false;
  for (const interceptor of interceptors) {
    const out = await interceptor(text, attachments, ctx);
    if (!out) continue;
    if (out.kind === 'handled') return;
    routedAgentId = out.activeAgentId ?? routedAgentId;
    boardSummoned = out.boardSummoned ?? boardSummoned;
    break; // a routing interceptor owns this turn's routing
  }

  // 4. `@<slug>` agent activation (skipped if an interceptor already routed).
  if (!attachments && !routedAgentId) {
    const agentMatch = detectAgentMention(text, ctx.agentEntries);
    if (agentMatch) {
      routedAgentId = ctx.activeAgents.activateAgent(agentMatch.entry);
      ctx.onAgentActivated?.(agentMatch.entry.agentId);
    }
  }

  // 5. send. The just-activated agent wins (its setSession may not have committed —
  //    React state is async — so the explicit activateAgent return dodges the race); a
  //    board summon NEVER falls back to a previously-selected single agent.
  const activeAgentId =
    routedAgentId ??
    (!boardSummoned && ctx.activeAgents.currentAgentId !== DEFAULT_ASSISTANT_ID ? ctx.activeAgents.currentAgentId : undefined);
  await ctx.send(text, ctx.config, {
    attachments,
    ...(ctx.baseSendOptions ? ctx.baseSendOptions() : {}),
    ...(activeAgentId ? { activeAgentId } : {}),
  });
}
