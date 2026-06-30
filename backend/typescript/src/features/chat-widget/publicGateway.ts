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
import { checkWidgetTurn } from './capsTracker.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { fenceUntrustedBlock } from '../../host/untrustedContent.js';
import { dispatchManagedChat } from '../../providers/managedProvider.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';
import { createLogger } from '../../observability/logger.js';
import type { ChatMessage } from '../../providers/dispatch.js';
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
      // PUBLIC projection only — no token, no tenantId, no secrets.
      res.json({ widgetId: widget.widgetId, agentId: widget.agentId, caps: widget.caps });
    } catch (err) { next(err); }
  });

  // Phase 2d — visitor dispatch (stateless single-turn, managed key, fenced input).
  deps.app.post('/v1/host/openwop-app/public/widget/message', async (req, res, next) => {
    try {
      const widget = await gateWidget(req);
      const body = (req.body ?? {}) as { message?: unknown; sessionId?: unknown };
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) throw new OpenwopError('validation_error', '`message` is required.', 400, { field: 'message' });
      if (message.length > MAX_VISITOR_MSG_CHARS) {
        throw new OpenwopError('validation_error', `\`message\` exceeds ${MAX_VISITOR_MSG_CHARS} characters.`, 413, { field: 'message' });
      }
      // Client-supplied opaque session id buckets the caps (2c). A visitor resetting
      // it is bounded by maxSessionsPerDay + the global per-IP rateLimit.
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 && body.sessionId.length <= 128 ? body.sessionId : 'anon';
      const day = new Date().toISOString().slice(0, 10);
      const cap = await checkWidgetTurn(widget, sessionId, day);
      if (!cap.allowed) {
        log.info('widget_cap_exceeded', { widgetId: widget.widgetId, reason: cap.reason }); // PUB-2
        throw new OpenwopError('rate_limited', 'This widget has reached its usage limit.', 429, { reason: cap.reason });
      }

      const agent = await getAgentRegistry().resolve(widget.agentId);
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

      const messages: ChatMessage[] = [
        { role: 'system', content: agent.systemPrompt },
        // ADR 0027 — untrusted external content. Fenced + placed as the USER turn so
        // it cannot override the persona/system turn above.
        { role: 'user', content: fenceUntrustedBlock(message, 'an anonymous website visitor') },
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

/** The served vanilla-JS widget (Phase 3). Plain string (browser code, not type-checked
 *  as Node) — textContent-only rendering + JS-applied styles for XSS/CSP safety. */
const EMBED_JS = [
  '(function(){',
  "  var s=document.currentScript||(function(){var a=document.getElementsByTagName('script');return a[a.length-1];})();",
  "  var src=(s&&s.src)||'';",
  "  var base=src.replace(/\\/widget\\/embed\\.js.*$/,'');",
  "  var token=(s&&s.getAttribute('data-token'))||((src.match(/[?&]token=([^&]+)/)||[])[1])||'';",
  '  if(!token||!base){return;}',
  '  var sid=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():String(Date.now())+Math.random();',
  "  function el(tag){return document.createElement(tag);}",
  "  var btn=el('button');btn.textContent='Chat';",
  "  btn.style.cssText='position:fixed;bottom:20px;right:20px;z-index:2147483000;border-radius:9999px;padding:12px 18px;border:none;background:#1a1a17;color:#fff;cursor:pointer;font:14px sans-serif;';",
  "  var panel=el('div');panel.style.cssText='position:fixed;bottom:74px;right:20px;z-index:2147483000;width:320px;max-width:90vw;height:420px;max-height:70vh;display:none;flex-direction:column;background:#fff;color:#1a1a17;border:1px solid #ddd;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.18);overflow:hidden;font:14px sans-serif;';",
  "  var list=el('div');list.style.cssText='flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;';",
  "  var row=el('div');row.style.cssText='display:flex;gap:6px;border-top:1px solid #eee;padding:8px;';",
  "  var input=el('input');input.type='text';input.setAttribute('aria-label','Message');input.style.cssText='flex:1;border:1px solid #ccc;border-radius:8px;padding:8px;font:14px sans-serif;';",
  "  var send=el('button');send.textContent='Send';send.style.cssText='border:none;background:#1a1a17;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;';",
  '  row.appendChild(input);row.appendChild(send);panel.appendChild(list);panel.appendChild(row);',
  "  function add(role,text){var d=el('div');d.textContent=text;d.style.cssText='max-width:85%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word;'+(role==='user'?'align-self:flex-end;background:#1a1a17;color:#fff;':'align-self:flex-start;background:#f1f1ef;color:#1a1a17;');list.appendChild(d);list.scrollTop=list.scrollHeight;}",
  '  var busy=false;',
  '  function sendMsg(){var m=input.value.replace(/^\\s+|\\s+$/g,\"\");if(!m||busy){return;}busy=true;add(\"user\",m);input.value=\"\";',
  "    fetch(base+'/widget/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token,message:m,sessionId:sid})})",
  "    .then(function(r){return r.ok?r.json():{reply:''};}).then(function(j){add('agent',(j&&j.reply)||'\\u2026');}).catch(function(){add('agent','\\u26a0\\ufe0f');}).then(function(){busy=false;});}",
  "  send.onclick=sendMsg;input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();sendMsg();}});",
  "  btn.onclick=function(){panel.style.display=(panel.style.display==='none')?'flex':'none';if(panel.style.display==='flex'){input.focus();}};",
  '  function mount(){document.body.appendChild(btn);document.body.appendChild(panel);}',
  "  if(document.body){mount();}else{document.addEventListener('DOMContentLoaded',mount);}",
  '})();',
].join('\n');
