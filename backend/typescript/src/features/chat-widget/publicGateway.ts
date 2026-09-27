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
 *     • HOST-OWNED key ONLY — dispatch rides `dispatchManagedChat` with the managed
 *       `openwop-free` provider charged to the widget's tenant. A visitor can NEVER
 *       supply or influence which key/provider runs; the key/tenantId never leave.
 *     • the untrusted visitor message is FENCED (ADR 0027) and placed as the USER
 *       turn, so it cannot override the agent persona (the system turn).
 *     • STATELESS single-turn (no per-visitor run/conversation accumulation) + a
 *       bounded reply + the per-session/day caps (2c) bound the abuse blast radius.
 *       The global per-IP rateLimit middleware also applies. Multi-turn sessions +
 *       tool-enabled dispatch are deferred follow-ons (each its own security pass).
 *
 * Tenant is derived from the resource. The response is a PUBLIC projection only.
 *
 * @see docs/adr/0127-public-embeddable-chat-widget.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveWidgetByToken, type WidgetConfig } from './widgetService.js';
import { originAllowed } from './originAllowlist.js';
import { checkWidgetTurn, checkAnonWrite, checkAnonAutoWrite } from './capsTracker.js';
import { createAnonSurfaceWriteApproval } from '../../host/approvalService.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { fenceUntrustedBlock } from '../../host/untrustedContent.js';
import { dispatchManagedChat, dispatchManagedToolsRound } from '../../providers/managedProvider.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';
import { createLogger } from '../../observability/logger.js';
import type { ChatMessage } from '../../providers/dispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../../executor/types.js';
import { anonymousActorEnabled, anonGrantHasTools, resolveAnonGrant, runAnonReadTurn } from '../../host/anonymousActor.js';
import { OpenwopError } from '../../types.js';

// PUB-2: structured abuse/enumeration visibility on the UNAUTHENTICATED widget surface
// (no operator signal otherwise). Never logs the token or visitor message — coarse only.
const log = createLogger('features.chat-widget.public');

/** The host-managed (host-owned key) provider a public widget dispatches through —
 *  NEVER a visitor key, NEVER the operator's key on the wire. */
const MANAGED_PROVIDER = 'openwop-free';
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
  const origin = (typeof req.headers.origin === 'string' && req.headers.origin) || (typeof req.headers.referer === 'string' ? req.headers.referer : undefined);
  if (!originAllowed(origin, widget.allowedDomains)) {
    log.info('widget_origin_rejected', { widgetId: widget.widgetId, origin }); // PUB-2
    throw new OpenwopError('forbidden', 'This domain is not allowed to embed this widget.', 403, {});
  }
  return widget;
}

export function registerChatWidgetPublicGateway(deps: RouteDeps): void {
  // Phase 2b — public config bootstrap (read-only).
  deps.app.get('/v1/host/openwop-app/public/widget/config', async (req, res, next) => {
    try {
      const widget = await gateWidget(req);
      // PUBLIC projection only — no token, no tenantId, no secrets. ADR 0470 OQ5 —
      // businessName + privacyUrl are operator-intended-public disclosure fields
      // (privacyUrl is http(s)-validated at write time; the embed re-checks).
      res.json({
        widgetId: widget.widgetId, agentId: widget.agentId, caps: widget.caps,
        ...(widget.businessName ? { businessName: widget.businessName } : {}),
        ...(widget.privacyUrl ? { privacyUrl: widget.privacyUrl } : {}),
      });
    } catch (err) { next(err); }
  });

  // Phase 2d — visitor dispatch (stateless single-turn, managed key, fenced input).
  deps.app.post('/v1/host/openwop-app/public/widget/message', async (req, res, next) => {
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
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 && body.sessionId.length <= 128 ? body.sessionId : 'anon';
      const day = new Date().toISOString().slice(0, 10);
      const cap = await checkWidgetTurn(widget, sessionId, day);
      if (!cap.allowed) {
        log.info('widget_cap_exceeded', { widgetId: widget.widgetId, reason: cap.reason }); // PUB-2
        throw new OpenwopError('rate_limited', 'This widget has reached its usage limit.', 429, { reason: cap.reason });
      }

      const agent = await getAgentRegistry().resolve(widget.agentId, widget.tenantId);
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

      // RFC 0132 §C — anonymous-actor tool tiers. When the operator has enabled it
      // AND this surface grants ≥1 tool, dispatch a real anon TOOL turn (default-
      // deny to exactly the surface grant, actingUserId undefined so secret/
      // deliverable tools fail closed, tenant-scoped; write tools held behind their
      // mandatory control) instead of the runless completion. An EMPTY grant (the
      // default) keeps today's exact behavior.
      const anonGrant = resolveAnonGrant(widget);
      if (anonymousActorEnabled() && anonGrantHasTools(anonGrant)) {
        // The managed (host-owned key) tool-round transport — the SAME daily caps +
        // provider-hiding as the runless dispatch, but a single tool round. A visitor
        // can NEVER supply or influence which key/provider runs.
        const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
          const round = await dispatchManagedToolsRound({
            userFacingProvider: MANAGED_PROVIDER,
            tenantId: widget.tenantId,
            messages: [
              { role: 'system', content: r.systemPrompt ?? '' },
              ...r.messages.map((m): ChatMessage => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
            ],
            tools: r.tools,
          });
          return { content: round.text, toolCalls: round.toolUses.map((t) => ({ id: t.id, name: t.name, input: t.input })) };
        };
        const turn = await runAnonReadTurn({
          storage: deps.storage,
          tenantId: widget.tenantId,
          agent: { agentId: agent.agentId, persona: agent.persona, systemPrompt: agent.systemPrompt },
          grant: anonGrant,
          surfaceSessionKey: `${widget.widgetId}:${sessionId}`,
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
        // PUBLIC projection — assistant text only; no token/tenantId/principal/secret.
        res.json({ reply: sanitizeFreeText(turn.reply) });
        return;
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: agent.systemPrompt },
        // ADR 0027 — untrusted external content. Fenced + placed as the USER turn so
        // it cannot override the persona/system turn above.
        { role: 'user', content: fenced },
      ];
      const result = await dispatchManagedChat({
        userFacingProvider: MANAGED_PROVIDER,
        tenantId: widget.tenantId,
        messages,
        maxTokens: MAX_REPLY_TOKENS,
      });
      // PUBLIC projection — only the assistant text, redacted; no token/tenantId/secret.
      res.json({ reply: sanitizeFreeText(typeof result.completion === 'string' ? result.completion : '') });
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
  deps.app.get('/v1/host/openwop-app/public/widget/embed.js', (_req, res) => {
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
  "  var token=(s&&s.getAttribute('data-token'))||((src.match(/[?&]token=([^&]+)/)||[])[1])||'';",
  '  if(!token||!base){return;}',
  '  var sid=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():String(Date.now())+Math.random();',
  "  function el(tag){return document.createElement(tag);}",
  '  var open=false;',
  "  var btn=el('button');btn.type='button';btn.textContent='Chat';btn.setAttribute('aria-label','Open chat');btn.setAttribute('aria-expanded','false');",
  "  btn.style.cssText='position:fixed;bottom:20px;right:20px;z-index:2147483000;min-height:44px;border-radius:9999px;padding:12px 20px;border:none;background:#1a1a17;color:#fff;cursor:pointer;font:14px sans-serif;';",
  "  var panel=el('div');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Chat with our AI assistant');panel.style.cssText='position:fixed;bottom:74px;right:20px;z-index:2147483000;width:340px;max-width:92vw;height:460px;max-height:72vh;display:none;flex-direction:column;background:#fff;color:#1a1a17;border:1px solid #ddd;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.18);overflow:hidden;font:14px sans-serif;';",
  // AI-disclosure + human-follow-up notice — always visible (privacy F2 notice-at-collection; competitive P9).
  "  var hdr=el('div');hdr.style.cssText='padding:8px 12px;font:12px sans-serif;color:#5a5a54;background:#f7f7f5;border-bottom:1px solid #eee;';",
  "  var note=el('span');note.textContent='AI assistant \\u00b7 a team member may follow up on what you share';hdr.appendChild(note);",
  // ADR 0470 OQ5 — enrich the disclosure from the widget's public config: the operator
  // business name + a notice-at-collection privacy LINK. The privacyUrl was http(s)-
  // validated server-side; re-check the scheme HERE before setting href (defense in
  // depth — never render a javascript:/data: href in the visitor's page).
  "  function applyConfig(c){if(!c){return;}if(c.businessName){note.textContent=String(c.businessName)+' \\u00b7 AI assistant \\u00b7 a team member may follow up';}",
  "    if(c.privacyUrl&&/^https?:\\/\\//i.test(String(c.privacyUrl))){var sep=el('span');sep.textContent=' \\u00b7 ';var a=el('a');a.textContent='Privacy';a.href=String(c.privacyUrl);a.target='_blank';a.rel='noopener noreferrer';a.style.cssText='color:#5a5a54;text-decoration:underline;';hdr.appendChild(sep);hdr.appendChild(a);}}",
  "  fetch(base+'/widget/config?token='+encodeURIComponent(token)).then(function(r){return r.ok?r.json():null;}).then(applyConfig).catch(function(){});",
  "  var list=el('div');list.setAttribute('role','log');list.setAttribute('aria-live','polite');list.setAttribute('aria-atomic','false');list.setAttribute('aria-label','Conversation');list.style.cssText='flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;';",
  "  var row=el('div');row.style.cssText='display:flex;gap:6px;border-top:1px solid #eee;padding:8px;';",
  "  var input=el('input');input.type='text';input.setAttribute('aria-label','Type your message');input.style.cssText='flex:1;min-height:44px;border:1px solid #ccc;border-radius:8px;padding:8px 10px;font:14px sans-serif;';",
  "  var send=el('button');send.type='button';send.textContent='Send';send.setAttribute('aria-label','Send message');send.style.cssText='min-height:44px;min-width:44px;border:none;background:#1a1a17;color:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;';",
  // ADR 0470 P3 — honeypot: a hidden decoy field a human never sees or fills (off-screen,
  // aria-hidden, not tabbable, autocomplete off). A form-scraper bot that fills every
  // field trips it; the server rejects a non-empty `hp`. Named to look fillable.
  "  var hp=el('input');hp.type='text';hp.name='contact_email_confirm';hp.tabIndex=-1;hp.setAttribute('aria-hidden','true');hp.autocomplete='off';hp.style.cssText='position:absolute;left:-9999px;width:1px;height:1px;opacity:0;';",
  '  row.appendChild(input);row.appendChild(send);panel.appendChild(hdr);panel.appendChild(list);panel.appendChild(hp);panel.appendChild(row);',
  "  function add(role,text){var d=el('div');d.textContent=text;d.style.cssText='max-width:85%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word;'+(role==='user'?'align-self:flex-end;background:#1a1a17;color:#fff;':'align-self:flex-start;background:#f1f1ef;color:#1a1a17;');list.appendChild(d);list.scrollTop=list.scrollHeight;return d;}",
  '  var busy=false;var typingEl=null;',
  // Reduced-motion-safe typing indicator: a static text bubble (no animation), announced politely via the log region.
  "  function showTyping(){if(typingEl){return;}typingEl=add('agent','Assistant is typing\\u2026');typingEl.setAttribute('aria-label','Assistant is typing');}",
  '  function hideTyping(){if(typingEl&&typingEl.parentNode){typingEl.parentNode.removeChild(typingEl);}typingEl=null;}',
  '  function sendMsg(){var m=input.value.replace(/^\\s+|\\s+$/g,\"\");if(!m||busy){return;}busy=true;send.disabled=true;add(\"user\",m);input.value=\"\";showTyping();',
  "    fetch(base+'/widget/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token,message:m,sessionId:sid,hp:hp.value})})",
  "    .then(function(r){return r.ok?r.json():{reply:''};}).then(function(j){hideTyping();add('agent',(j&&j.reply)||'Sorry, I could not respond just now. Please try again.');}).catch(function(){hideTyping();add('agent','Sorry, something went wrong. Please try again.');}).then(function(){busy=false;send.disabled=false;});}",
  "  send.onclick=sendMsg;input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();sendMsg();}});",
  "  function setOpen(v){open=v;panel.style.display=v?'flex':'none';btn.setAttribute('aria-expanded',v?'true':'false');if(v){input.focus();}else{btn.focus();}}",
  '  btn.onclick=function(){setOpen(!open);};',
  "  panel.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();setOpen(false);}});",
  '  function mount(){document.body.appendChild(btn);document.body.appendChild(panel);}',
  "  if(document.body){mount();}else{document.addEventListener('DOMContentLoaded',mount);}",
  '})();',
].join('\n');
