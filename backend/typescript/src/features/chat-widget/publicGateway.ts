/**
 * ADR 0127 Phase 2b/2d — the PUBLIC widget gateway (under `/v1/host/openwop-app/public/*`,
 * which bypasses auth by design). UNAUTHENTICATED: the unguessable `wgt_` token is
 * the capability, and the request Origin/Referer MUST pass the widget's
 * `allowedDomains` allowlist (default-deny, eTLD+1-spoof-proof — Phase 2a).
 *
 * - Phase 2b: GET `/widget/config` returns ONLY the embed's public config (agentId +
 *   caps) — never the token, the tenantId, or any secret.
 * - Phase 2d: POST `/widget/message` is the visitor DISPATCH. Security posture
 *   (reviewed via /architect, security focus):
 *     • fail-closed at every gate — unknown/disabled token → uniform 404; absent/
 *       mismatched Origin → 403; caps exceeded → 429; unknown agent → uniform 404.
 *     • the OWNER's key — ADR 1018 D8: the turn runs on the credential
 *       `resolveWidgetCredential` names (the workspace's own BYOK key; the platform's
 *       managed key only for a listed superadmin tenant), and stops — fail-closed, no
 *       managed fallback — when it names none. A visitor can NEVER supply or influence
 *       which key/provider runs; the key/tenantId never leave.
 *     • the untrusted visitor message is FENCED (ADR 0027) and placed as the USER
 *       turn, so it cannot override the agent persona (the system turn).
 *     • a bounded reply + the per-session/day caps (2c) bound the abuse blast radius;
 *       the global per-IP rateLimit middleware also applies. ADR 1018 D2 added a
 *       BOUNDED server-held visitor thread (the last 8 stored messages, re-fenced,
 *       `visitorThreads.ts`); the anon tool lane (RFC 0132 §C) shipped in ADR 0469.
 *       (This used to say "STATELESS single-turn … multi-turn deferred".)
 *
 * Tenant is derived from the resource. The response is a PUBLIC projection only.
 *
 * @see docs/adr/0127-public-embeddable-chat-widget.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveWidgetByToken, type WidgetConfig } from './widgetService.js';
import { hostOf, originAllowed } from './originAllowlist.js';
import { visitorSessionKeys, threadContext, appendExchange, THREAD_TTL_DAYS } from './visitorThreads.js';
import { checkWidgetTurn, checkAnonWrite, checkAnonAutoWrite } from './capsTracker.js';
import { createAnonSurfaceWriteApproval } from '../../host/approvalService.js';
import { fenceUntrustedBlock } from '../../host/untrustedContent.js';
import { resolveWidgetCredential, widgetChat, widgetToolsRound, WIDGET_REFUSAL_LOG_CODE } from './widgetCredential.js';
import { meterPlatformUnits } from '../../host/managedCredits.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';
import { createLogger } from '../../observability/logger.js';
import type { ChatMessage } from '../../providers/dispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../../executor/types.js';
import { toolRoundResult } from '../../aiProviders/aiProvidersHost.js';
import { anonymousActorEnabled, anonGrantHasTools, resolveAnonGrant, runAnonReadTurn } from '../../host/anonymousActor.js';
import { OpenwopError } from '../../types.js';
import { resolveToggle } from '../../host/featureToggles/service.js';
import { ownerPublicRuntimeLapsed } from '../../host/publicLapse.js';
import { resolveServedAgent } from '../../host/agentServing.js';

// PUB-2: structured abuse/enumeration visibility on the UNAUTHENTICATED widget surface
// (no operator signal otherwise). Never logs the token or visitor message — coarse only.
const log = createLogger('features.chat-widget.public');

/** Bound the untrusted visitor input + the reply (DoS/abuse guard). */
const MAX_VISITOR_MSG_CHARS = 4000;
const MAX_REPLY_TOKENS = 512;

/** Token + Origin gate shared by both public routes (no per-route drift). Resolves
 *  the widget or throws the fail-closed error. Uniform 404 avoids an existence
 *  oracle; an off-allowlist origin is a 403. */
async function gateWidget(req: Request): Promise<WidgetConfig> {
  const token = typeof req.query.token === 'string' ? req.query.token
    : (typeof (req.body as { token?: unknown } | undefined)?.token === 'string' ? (req.body as { token: string }).token : '');
  const widget = await resolveWidgetByToken(token);
  if (!widget) {
    log.info('widget_token_miss', { path: req.path }); // PUB-2: enumeration / stale-token signal
    throw new OpenwopError('not_found', 'Widget not found.', 404, {});
  }
  // ADR 0820 §7 / §8.2 — the owner-lapse policy for the public gateway (off unless the grace
  // knob is set). A no-op while `chat-widget` is always-on (in no paid bundle); it bites the
  // day §8.2 moves it into Support. The visitor is never refused for their own state.
  if (await ownerPublicRuntimeLapsed('chat-widget', widget.tenantId)) {
    throw new OpenwopError('not_found', 'Widget not found.', 404, {});
  }
  const origin = (typeof req.headers.origin === 'string' && req.headers.origin) || (typeof req.headers.referer === 'string' ? req.headers.referer : undefined);
  if (!originAllowed(origin, widget.allowedDomains)) {
    // ADR 1018 D6 — the HOST only. A Referer is the visitor's full page URL, query
    // string included, and has no business in the log.
    log.info('widget_origin_rejected', { widgetId: widget.widgetId, originHost: origin ? hostOf(origin) : null }); // PUB-2
    throw new OpenwopError('forbidden', 'This domain is not allowed to embed this widget.', 403, {});
  }
  // ADR 0820 §8.2 — the tenant's `chat-widget` switch. A VISITOR lane: the tenant
  // comes from the widget (the resource), never the caller, so this reads the
  // TOGGLE only (`resolveToggle`, a ratchet-listed opt-out). Paywalling it with
  // `resolveOne` would 404 every visitor of an owner whose plan lapsed, and every
  // tenant's visitors on an entitlement-read fault (the ADR 0819 A2 class); the
  // ADR 0176 shopper exemption keeps visitors off the owner's plan. The owner's
  // plan is enforced on the operator routes (`authorizeOrgScope`).
  // The owner-lapse policy (ADR 0820 §7) is applied above via `ownerPublicRuntimeLapsed`.
  const toggle = await resolveToggle('chat-widget', { tenantId: widget.tenantId }).catch(() => null);
  if (toggle?.enabled !== true) {
    log.info('widget_feature_off', { widgetId: widget.widgetId }); // PUB-2: coarse only
    throw new OpenwopError('not_found', 'Widget not found.', 404, {}); // uniform 404 — no existence oracle
  }
  return widget;
}

export function registerChatWidgetPublicGateway(deps: RouteDeps): void {
  // Phase 2b — public config bootstrap (read-only).
  deps.app.get('/host/openwop-app/public/widget/config', async (req, res, next) => {
    try {
      const widget = await gateWidget(req);
      // PUBLIC projection only — no token, no tenantId, no secrets. ADR 0470 OQ5 —
      // businessName + privacyUrl are operator-intended-public disclosure fields
      // (privacyUrl is http(s)-validated at write time; the embed re-checks).
      res.json({
        widgetId: widget.widgetId, agentId: widget.agentId, caps: widget.caps,
        // ADR 1018 D3 — the visitor notice states the real retention, from the one constant.
        retentionDays: THREAD_TTL_DAYS,
        ...(widget.businessName ? { businessName: widget.businessName } : {}),
        ...(widget.privacyUrl ? { privacyUrl: widget.privacyUrl } : {}),
      });
    } catch (err) { next(err); }
  });

  // Phase 2d — visitor dispatch (the owner's key, fenced input; ADR 1018 bounded thread).
  deps.app.post('/host/openwop-app/public/widget/message', async (req, res, next) => {
    try {
      const widget = await gateWidget(req);
      const body = (req.body ?? {}) as { message?: unknown; sessionId?: unknown; hp?: unknown };
      // ADR 0470 P3 — honeypot: the real widget always sends `hp` EMPTY (a hidden decoy
      // field a human never sees). A non-empty value ⇒ a form-scraper bot filled it →
      // reject with a GENERIC error (never reveal the honeypot). Cheap defense-in-depth
      // on top of the per-IP rate limit + the P3 default write ceiling.
      if (typeof body.hp === 'string' && body.hp.trim().length > 0) {
        log.info('widget_honeypot_tripped', { widgetId: widget.widgetId }); // PUB-2 abuse signal
        throw new OpenwopError('validation_error', 'Invalid request.', 400, {});
      }
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) throw new OpenwopError('validation_error', '`message` is required.', 400, { field: 'message' });
      if (message.length > MAX_VISITOR_MSG_CHARS) {
        throw new OpenwopError('validation_error', `\`message\` exceeds ${MAX_VISITOR_MSG_CHARS} characters.`, 413, { field: 'message' });
      }
      // Client-supplied opaque session id buckets the caps (2c). A visitor resetting
      // it is bounded by maxSessionsPerDay + the global per-IP rateLimit.
      //
      // ADR 0707 — that sentence used to be true only of a CONFIGURED widget: an unset
      // `maxSessionsPerDay` defaulted to Infinity, so for the DEFAULT configuration the
      // first half of the bound did nothing and rotation was held only by the per-IP
      // limit. `checkWidgetTurn` now applies a secure default, so the bound above holds
      // for an unconfigured widget too.
      //
      // ADR 1018 / grade-code `CW68C-2` — the counters key on a HASH of the client id
      // (`visitorSessionKeys`); the raw id is a thread credential and is stored nowhere.
      const { sessionKey: sessionId, threadId } = visitorSessionKeys(widget.widgetId, body.sessionId);
      // ADR 1018 D8 — which key answers, asked BEFORE a cap is claimed. Refused ⇒ the
      // widget stops answering (the embed's generic "could not respond"); it never
      // falls back to the platform's managed key. The log names the reason.
      const cred = await resolveWidgetCredential(widget.tenantId);
      if (cred.kind === 'refused') {
        log.warn('widget_credential_refused', { widgetId: widget.widgetId, reasonCode: WIDGET_REFUSAL_LOG_CODE[cred.reason] });
        throw new OpenwopError('service_unavailable', 'This widget cannot respond right now.', 503, {});
      }
      const day = new Date().toISOString().slice(0, 10);
      const cap = await checkWidgetTurn(widget, sessionId, day);
      if (!cap.allowed) {
        log.info('widget_cap_exceeded', { widgetId: widget.widgetId, reason: cap.reason }); // PUB-2
        throw new OpenwopError('rate_limited', 'This widget has reached its usage limit.', 429, { reason: cap.reason });
      }
      // ADR 0821 D3 — a visitor conversation is platform-paid spend billed to the
      // widget OWNER (never the visitor: no visitor-facing refusal is added). Metered
      // once, when the turn that opened it has been answered. No draw while
      // `widgetConversation` has no rate.
      const meterConversation = async (): Promise<void> => {
        if (cap.newSession) await meterPlatformUnits({ tenantId: widget.tenantId, unit: 'widgetConversation', quantity: 1, featureId: 'chat-widget' });
      };

      const agent = await resolveServedAgent(widget.agentId, widget.tenantId, widget.widgetId); // ADR 1014 D4
      // A misconfigured (deleted) agent → uniform 404, no existence oracle. PUB-4: a
      // user-authored agent owned by ANOTHER tenant must not run (its systemPrompt is
      // tenant-owned IP, agent-memory.md CTI-1) — built-in agents (no ownerTenant) are
      // shared by design. Uniform 404 (no cross-tenant existence oracle).
      if (!agent || (agent.ownerTenant && agent.ownerTenant !== widget.tenantId)) {
        if (agent?.ownerTenant && agent.ownerTenant !== widget.tenantId) {
          log.warn('widget_cross_tenant_agent_blocked', { widgetId: widget.widgetId });
        }
        throw new OpenwopError('not_found', 'Widget not found.', 404, {});
      }

      const fenced = fenceUntrustedBlock(message, 'an anonymous website visitor');
      // ADR 1018 D2 — the visitor's prior turns (bounded, re-fenced). Only a session id
      // the embed minted threads; the shared `'anon'` fallback never does.
      const history = await threadContext(widget, threadId);

      // RFC 0132 §C — anonymous-actor tool tiers. When the operator has enabled it
      // AND this surface grants ≥1 tool, dispatch a real anon TOOL turn (default-
      // deny to exactly the surface grant, actingUserId undefined so secret/
      // deliverable tools fail closed, tenant-scoped; write tools held behind their
      // mandatory control) instead of the runless completion. An EMPTY grant (the
      // default) keeps today's exact behavior.
      const anonGrant = resolveAnonGrant(widget);
      if (anonymousActorEnabled() && anonGrantHasTools(anonGrant)) {
        // One tool round on the resolved credential (ADR 1018 D8). A visitor can NEVER
        // supply or influence which key/provider runs.
        const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
          const round = await widgetToolsRound(widget.tenantId, cred, [
            { role: 'system', content: r.systemPrompt ?? '' },
            ...r.messages.map((m): ChatMessage => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
          ], r.tools);
          return toolRoundResult(round);
        };
        const turn = await runAnonReadTurn({
          storage: deps.storage,
          tenantId: widget.tenantId,
          agent: { agentId: agent.agentId, persona: agent.persona, systemPrompt: agent.systemPrompt },
          grant: anonGrant,
          surfaceSessionKey: `${widget.widgetId}:${sessionId}`,
          history,
          fencedUserMessage: fenced,
          callAIWithTools,
          // ADR 0469 A2 — a GRANTED write is HELD for operator review, never executed
          // in-turn. Gate the per-day write cap FIRST (anti-flood: a bot must not flood
          // the operator inbox), then create the durable idempotent hold. This feature
          // owns the widget + caps + approval store; the host actor stays agnostic.
          holdGrantedWrite: async (call, hctx) => {
            const capd = await checkAnonWrite(widget, day);
            if (!capd.allowed) {
              log.info('widget_anon_write_capped', { widgetId: widget.widgetId }); // PUB-2
              return { status: 'capped' };
            }
            try {
              // ADR 0470 — surface any visitor-supplied lead PII (email/name/note) on the
              // approval's flat `captured*` fields so the operator SEES the lead in the
              // review card and the OD4 redactor covers it on erasure. GENERIC (keyed on
              // well-known arg names, not a tool id) — no coupling to a specific tool.
              const a = (call.input ?? {}) as Record<string, unknown>;
              const capStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined);
              const captured = { name: capStr(a.name), email: capStr(a.email), note: capStr(a.note) };
              await createAnonSurfaceWriteApproval({
                tenantId: widget.tenantId,
                orgId: widget.orgId,
                widgetId: widget.widgetId,
                principal: hctx.principal,
                runId: hctx.runId,
                toolCallIdx: hctx.toolCallIdx,
                tool: { name: call.name, ...(call.input ? { args: call.input } : {}) },
                ...((captured.name || captured.email || captured.note) ? { captured } : {}),
              });
              return { status: 'held' };
            } catch (err) {
              log.warn('widget_anon_write_hold_failed', { widgetId: widget.widgetId, error: err instanceof Error ? err.message : String(err) });
              return { status: 'error' };
            }
          },
          // ADR 0469 Phase D — the `rate-limit-session-cap` control: gate an auto-run
          // write against the per-SESSION cap AND the per-DAY cap (defense in depth —
          // a bot cycling sessions is still bounded per-day). Both must pass; each
          // increments on allow. Only reached for a pure tenant-write surface (the host
          // actor falls back to the hold path when egress audiences are declared).
          autoWriteUnderCap: async () => {
            const perSession = await checkAnonAutoWrite(widget, sessionId, day);
            if (!perSession.allowed) { log.info('widget_anon_auto_write_capped', { widgetId: widget.widgetId, scope: 'session' }); return { allowed: false }; }
            const perDay = await checkAnonWrite(widget, day);
            if (!perDay.allowed) { log.info('widget_anon_auto_write_capped', { widgetId: widget.widgetId, scope: 'day' }); return { allowed: false }; }
            return { allowed: true };
          },
        });
        await meterConversation();
        const reply = sanitizeFreeText(turn.reply);
        // grade-code `CW68C-5` — a failed or empty turn is not a conversation turn.
        if (!turn.failed && reply.trim()) await appendExchange(widget, threadId, message, reply, new Date().toISOString());
        // PUBLIC projection — assistant text only; no token/tenantId/principal/secret.
        res.json({ reply });
        return;
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: agent.systemPrompt },
        ...history,
        // ADR 0027 — untrusted external content. Fenced + placed as the USER turn so
        // it cannot override the persona/system turn above.
        { role: 'user', content: fenced },
      ];
      const completion = await widgetChat(widget.tenantId, cred, messages, MAX_REPLY_TOKENS);
      await meterConversation();
      const reply = sanitizeFreeText(completion);
      if (reply.trim()) await appendExchange(widget, threadId, message, reply, new Date().toISOString());
      // PUBLIC projection — only the assistant text, redacted; no token/tenantId/secret.
      res.json({ reply });
    } catch (err) { next(err); }
  });

  // Phase 3 — the embed snippet. A self-contained vanilla-JS widget a site owner
  // pastes (<script src=".../widget/embed.js" data-token="wgt_…"></script>). It is
  // IDENTICAL for every widget (the token is read at runtime from its own tag), so
  // it is a static, cacheable, NON-normative served string — no SPA bundle, no
  // entry-budget impact. SECURITY: it renders ALL message text via textContent (never
  // innerHTML → XSS-safe on the host page), applies styles via JS `.style` props (no
  // injected <style> → no host-CSP style-src violation), derives its API base from
  // its OWN src origin, and only ever touches the origin-gated 2b/2d endpoints. The
  // token in the markup is the ADR 0013 capability token (origin-gated server-side,
  // not a secret); no tenantId/key is ever exposed to it.
  deps.app.get('/host/openwop-app/public/widget/embed.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(EMBED_JS);
  });
}

/** The served vanilla-JS widget (Phase 3; ADR 0470 P2 — best-in-class visitor UX).
 *  Plain string (browser code, not type-checked as Node) — textContent-only rendering +
 *  JS-applied styles for XSS/CSP safety. ADR 0470 adds, per the cited research: an
 *  always-visible AI-disclosure + human-follow-up notice (competitive P9 / privacy F2);
 *  a `role="log"` `aria-live="polite"` transcript that announces new messages without
 *  stealing focus (WCAG 2.2 SC 4.1.3); a reduced-motion-safe text typing indicator
 *  (NN/g response-time honesty; SC 2.3.3); APG dialog focus flow (open→input,
 *  Escape/close→launcher); ≥44px touch targets (SC 2.5.5); `aria-expanded` on the
 *  launcher; and an honest error message (never silence). */
const EMBED_JS = [
  '(function(){',
  "  var s=document.currentScript||(function(){var a=document.getElementsByTagName('script');return a[a.length-1];})();",
  "  var src=(s&&s.src)||'';",
  "  var base=src.replace(/\\/widget\\/embed\\.js.*$/,'');",
  // ADR 0806 — a snippet pasted before ADR 0671 names the `/v1` twin. That address
  // forwards (308) after the cut, but `currentScript.src` keeps the ORIGINAL URL,
  // so a base derived from it would post every message to a retired address.
  // Always talk to the unversioned vendor root, which is served on both sides.
  // Anchored on the origin (plus an optional `/api` proxy prefix), so a
  // customer path that merely CONTAINS `/v3/host/` is left alone.
  "  base=base.replace(/^(https?:\\/\\/[^\\/]+(?:\\/api)?)\\/v[0-9]+(\\/host\\/)/,'$1$2');",
  "  var token=(s&&s.getAttribute('data-token'))||((src.match(/[?&]token=([^&]+)/)||[])[1])||'';",
  '  if(!token||!base){return;}',
  // ADR 1018 D2 — the session id and this tab's transcript live in sessionStorage, so a
  // visitor who navigates within the customer's site keeps one thread. Every access is
  // guarded (a private window or blocked storage throws) and falls back to a per-page
  // session. The key is per token, so two widgets on one site never share a thread. The
  // fallback id is shaped to FAIL the server's thread grammar (dots), so a browser
  // without crypto.randomUUID stays stateless rather than threading on a weak id.
  "  var SK='owp-widget:'+token;",
  "  function load(){try{var v=window.sessionStorage.getItem(SK);return v?JSON.parse(v):null;}catch(e){return null;}}",
  "  function save(st){try{window.sessionStorage.setItem(SK,JSON.stringify(st));}catch(e){}}",
  "  var st=load();if(!st||typeof st.sid!=='string'||!(st.log instanceof Array)){st={sid:(window.crypto&&crypto.randomUUID)?crypto.randomUUID():String(Date.now())+'.'+Math.random(),log:[]};}",
  '  var sid=st.sid;',
  "  function el(tag){return document.createElement(tag);}",
  '  var open=false;',
  "  var btn=el('button');btn.type='button';btn.textContent='Chat';btn.setAttribute('aria-label','Open chat');btn.setAttribute('aria-expanded','false');btn.setAttribute('aria-haspopup','dialog');",
  "  btn.style.cssText='position:fixed;bottom:20px;right:20px;z-index:2147483000;min-height:44px;border-radius:9999px;padding:12px 20px;border:none;background:#1a1a17;color:#fff;cursor:pointer;font:14px sans-serif;';",
  "  var panel=el('div');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Chat with our AI assistant');panel.style.cssText='position:fixed;bottom:74px;right:20px;z-index:2147483000;width:340px;max-width:92vw;height:460px;max-height:calc(100vh - 96px);max-height:calc(100dvh - 96px);display:none;flex-direction:column;background:#fff;color:#1a1a17;border:1px solid #ddd;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.18);overflow:hidden;font:14px sans-serif;';",
  // grade-ux CW68U-7 — on a phone the panel takes the width and stays above the launcher.
  "  try{if(window.matchMedia&&window.matchMedia('(max-width:480px)').matches){panel.style.left='8px';panel.style.right='8px';panel.style.width='auto';panel.style.maxWidth='none';}}catch(e){}",
  // AI-disclosure + human-follow-up notice — always visible (privacy F2 notice-at-collection; competitive P9).
  "  var hdr=el('div');hdr.style.cssText='display:flex;align-items:flex-start;gap:8px;padding:8px 12px;font:12px sans-serif;color:#5a5a54;background:#f7f7f5;border-bottom:1px solid #eee;';",
  "  var info=el('div');info.style.cssText='flex:1;';hdr.appendChild(info);",
  "  var note=el('span');note.textContent='AI assistant \\u00b7 a team member may follow up on what you share';info.appendChild(note);",
  // grade-ux CW68U-6 — a labelled close control (Escape alone is not reachable by touch).
  "  var closeBtn=el('button');closeBtn.type='button';closeBtn.textContent='\\u00d7';closeBtn.setAttribute('aria-label','Close chat');closeBtn.style.cssText='min-width:44px;min-height:44px;margin:-8px -8px -8px 0;border:none;background:transparent;color:#1a1a17;font:20px sans-serif;cursor:pointer;';hdr.appendChild(closeBtn);",
  // ADR 0470 OQ5 — enrich the disclosure from the widget's public config: the operator
  // business name + a notice-at-collection privacy LINK. The privacyUrl was http(s)-
  // validated server-side; re-check the scheme HERE before setting href (defense in
  // depth — never render a javascript:/data: href in the visitor's page).
  // ADR 1018 D3 / grade-ux CW68U-5 — the notice says the conversation is KEPT, for how
  // long (the server's own TTL, from the config), and who can read it.
  "  function applyConfig(c){if(!c){return;}var who=c.businessName?String(c.businessName):'our team';var keep=(typeof c.retentionDays==='number'&&c.retentionDays>0)?' \\u00b7 this chat is kept for '+c.retentionDays+' days and '+who+' can read it':' \\u00b7 a team member may follow up';note.textContent=(c.businessName?String(c.businessName)+' \\u00b7 ':'')+'AI assistant'+keep;",
  "    if(c.privacyUrl&&/^https?:\\/\\//i.test(String(c.privacyUrl))){var sep=el('span');sep.textContent=' \\u00b7 ';var a=el('a');a.textContent='Privacy';a.href=String(c.privacyUrl);a.target='_blank';a.rel='noopener noreferrer';a.style.cssText='color:#5a5a54;text-decoration:underline;';info.appendChild(sep);info.appendChild(a);}}",
  "  var list=el('div');list.setAttribute('role','log');list.setAttribute('aria-live','polite');list.setAttribute('aria-atomic','false');list.setAttribute('aria-label','Conversation');list.style.cssText='flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;';",
  "  var row=el('div');row.style.cssText='display:flex;gap:6px;border-top:1px solid #eee;padding:8px;';",
  "  var input=el('input');input.type='text';input.setAttribute('aria-label','Type your message');input.maxLength=4000;input.style.cssText='flex:1;min-width:0;min-height:44px;border:1px solid #ccc;border-radius:8px;padding:8px 10px;font:16px sans-serif;';",
  "  var send=el('button');send.type='button';send.textContent='Send';send.setAttribute('aria-label','Send message');send.style.cssText='min-height:44px;min-width:44px;border:none;background:#1a1a17;color:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;';",
  // ADR 0470 P3 — honeypot: a hidden decoy field a human never sees or fills (off-screen,
  // aria-hidden, not tabbable, autocomplete off). A form-scraper bot that fills every
  // field trips it; the server rejects a non-empty `hp`. Named to look fillable.
  "  var hp=el('input');hp.type='text';hp.name='contact_email_confirm';hp.tabIndex=-1;hp.setAttribute('aria-hidden','true');hp.autocomplete='off';hp.style.cssText='position:absolute;left:-9999px;width:1px;height:1px;opacity:0;';",
  '  row.appendChild(input);row.appendChild(send);panel.appendChild(hdr);panel.appendChild(list);panel.appendChild(hp);panel.appendChild(row);',
  "  function add(role,text,keep){if(keep){st.log.push({r:role,t:String(text)});if(st.log.length>40){st.log=st.log.slice(-40);}save(st);}var d=el('div');d.textContent=text;d.style.cssText='max-width:85%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word;'+(role==='user'?'align-self:flex-end;background:#1a1a17;color:#fff;':'align-self:flex-start;background:#f1f1ef;color:#1a1a17;');list.appendChild(d);list.scrollTop=list.scrollHeight;return d;}",
  '  var busy=false;var typingEl=null;',
  // Restore this tab's transcript through the same textContent-only add() (never kept again).
  "  for(var i=0;i<st.log.length;i++){var e=st.log[i];if(e&&(e.r==='user'||e.r==='agent')&&typeof e.t==='string'){add(e.r,e.t,false);}}",
  // Reduced-motion-safe typing indicator: a static text bubble (no animation), announced politely via the log region.
  "  function showTyping(){if(typingEl){return;}typingEl=add('agent','Assistant is typing\\u2026');typingEl.setAttribute('aria-label','Assistant is typing');}",
  '  function hideTyping(){if(typingEl&&typingEl.parentNode){typingEl.parentNode.removeChild(typingEl);}typingEl=null;}',
  // grade-code CW68C-13 — the visitor's message joins the kept transcript only WITH its
  // reply, matching what the server stored; a failed turn is shown but not restored.
  '  function sendMsg(){var m=input.value.replace(/^\\s+|\\s+$/g,\"\");if(!m||busy){return;}busy=true;send.disabled=true;add(\"user\",m,false);input.value=\"\";showTyping();',
  "    fetch(base+'/widget/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token,message:m,sessionId:sid,hp:hp.value})})",
  "    .then(function(r){if(r.status===429){return {busy:true};}return r.ok?r.json():{reply:''};}).then(function(j){hideTyping();if(j&&j.reply){st.log.push({r:'user',t:m});add('agent',j.reply,true);}else if(j&&j.busy){add('agent','This chat is busy right now. Please come back later.');}else{add('agent','Sorry, I could not respond just now. Please try again.');}}).catch(function(){hideTyping();add('agent','Sorry, something went wrong. Please try again.');}).then(function(){busy=false;send.disabled=false;});}",
  "  send.onclick=sendMsg;input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();sendMsg();}});",
  "  function setOpen(v){open=v;panel.style.display=v?'flex':'none';btn.setAttribute('aria-expanded',v?'true':'false');btn.setAttribute('aria-label',v?'Close chat':'Open chat');if(v){input.focus();}else{btn.focus();}}",
  '  btn.onclick=function(){setOpen(!open);};closeBtn.onclick=function(){setOpen(false);};',
  "  panel.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();setOpen(false);}});",
  '  function mount(){document.body.appendChild(btn);document.body.appendChild(panel);}',
  // grade-ux CW68U-3 — mount ONLY once the widget's own config answers. A wrong domain,
  // a rotated token or a disabled widget used to mount a chat that could never reply;
  // now the page shows nothing and the console says why, for the site owner.
  "  fetch(base+'/widget/config?token='+encodeURIComponent(token)).then(function(r){if(!r.ok){if(window.console&&console.warn){console.warn('OpenWOP chat widget not shown: '+(r.status===403?'this site is not in the widget\\'s allowed domains':r.status===404?'unknown, disabled or rotated widget token':'HTTP '+r.status));}return null;}return r.json();})",
  "  .then(function(c){if(!c){return;}applyConfig(c);if(document.body){mount();}else{document.addEventListener('DOMContentLoaded',mount);}}).catch(function(){});",
  '})();',
].join('\n');
