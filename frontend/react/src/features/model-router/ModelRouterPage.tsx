/**
 * ADR 0130 Phase 5 / ADR 1016 — the model-router rule editor (admin).
 *
 * ONE config per workspace (ADR 1016 D1): every chat in the active workspace is
 * judged against it, message by message (D3). Each rule is "when <condition> →
 * use <provider>/<model>"; an OPTIONAL fallback catches messages no rule matches
 * (D5 — without one they keep the conversation's own model). A rule applies only
 * to conversations whose key belongs to its provider, and never to the free tier
 * or a subscription (D4), so the page says so rather than letting an admin expect
 * cross-provider routing. Targets are picked from the catalog (`providers.json`),
 * never typed (D5 — the server refuses an unlisted model).
 *
 * Who may change it is the server's call (`canManage`, BYOK-manage authority —
 * D2); everyone else sees the rules read-only and can still test a message with
 * the preview (D6), which runs the same decision the chat runs.
 *
 * @see docs/adr/1016-model-router-workspace-per-turn-routing.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { CheckboxField, SelectField, TextareaField, TextField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { PROVIDERS } from '../../byok/lib/providers.js';
import {
  getRouterConfig, setRouterConfig, setRouterEnabled, previewRoute,
  type RoutePreview, type RoutingRule, type RoutingTarget, type RuleCondition,
} from './modelRouterClient.js';

type CondKind = RuleCondition['kind'];
type TFn = ReturnType<typeof useTranslation>['t'];
const COND_KINDS: CondKind[] = ['always', 'attachment', 'tokensOver', 'difficultyAtLeast', 'conversationKind'];
const DIFFICULTY_LEVELS = ['low', 'medium', 'high'] as const;
const CONVERSATION_KINDS = ['group', 'workspace', 'channel'] as const;

/** The providers a rule may target: the user BYOK providers (ADR 0610 D4 — the
 *  managed tier and hidden providers are never routable). */
const ROUTABLE = PROVIDERS.filter((p) => p.managed !== true && p.hidden !== true);

/** The catalog's label for a target, or `null` when the catalog does not list it
 *  (a rule saved before ADR 1016 D5 — inert, and refused on the next save). */
function modelLabel(target: RoutingTarget): string | null {
  const provider = ROUTABLE.find((p) => p.id === target.provider);
  const model = provider?.models.find((m) => m.id === target.model);
  return provider && model ? `${provider.label} · ${model.label}` : null;
}

/** Does the catalog say this model reads images? (An attachment message only
 *  routes to one that does — ADR 1016 D4.) */
function acceptsImages(target: RoutingTarget): boolean {
  return ROUTABLE.find((p) => p.id === target.provider)?.models.find((m) => m.id === target.model)?.capabilities.includes('vision') ?? false;
}

const defaultTarget = (): RoutingTarget => {
  const p = ROUTABLE[0];
  const m = p?.models.find((x) => x.recommended) ?? p?.models[0];
  return { provider: p?.id ?? '', model: m?.id ?? '' };
};

function condLabel(c: RuleCondition, t: TFn): string {
  switch (c.kind) {
    case 'always': return t('condAlways', { defaultValue: 'every message' });
    case 'attachment': return t('condAttachment', { defaultValue: 'the message has an attachment' });
    case 'tokensOver': return t('condTokensOver', { defaultValue: 'the message is over {{n}} tokens', n: c.threshold });
    case 'difficultyAtLeast': return t('condDifficultyAtLeast', { defaultValue: 'difficulty is at least {{level}}', level: t(`difficulty_${c.level}`, { defaultValue: c.level }) });
    case 'conversationKind': return t('condConversationKind', { defaultValue: 'the conversation is a {{value}}', value: t(`convKind_${c.value}`, { defaultValue: c.value }) });
  }
}

export function ModelRouterPage(): JSX.Element {
  const { t } = useTranslation('model-router');
  const { embedded } = useHub(); // a tab inside the Models console → drop our own header
  const [loaded, setLoaded] = useState(false);
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [fallback, setFallback] = useState<RoutingTarget | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hasConfig, setHasConfig] = useState(false);
  const [canManage, setCanManage] = useState(false);
  /** MR-G1 — the stored config could not be READ, so every write on this page
   *  would be built on state we do not have. Distinct from `!hasConfig`, which
   *  means we read successfully and there is none. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Bumped on every saved change, so a preview answer computed against the old
   *  rules is cleared rather than left on screen (MR66UX-1). */
  const [configVersion, setConfigVersion] = useState(0);

  // add-rule form state
  const [kind, setKind] = useState<CondKind>('tokensOver');
  const [threshold, setThreshold] = useState('4000');
  const [conversationKind, setConversationKind] = useState<(typeof CONVERSATION_KINDS)[number]>('group');
  const [difficulty, setDifficulty] = useState<(typeof DIFFICULTY_LEVELS)[number]>('high');
  const [target, setTarget] = useState<RoutingTarget>(defaultTarget);

  const load = useCallback(() => {
    setLoadFailed(false);
    void getRouterConfig().then(({ stored, canManage: may }) => {
      setHasConfig(stored !== null);
      setEnabled(stored?.enabled ?? false);
      setRules(stored?.config.rules ?? []);
      setFallback(stored?.config.fallback ?? null);
      setCanManage(may);
      setLoaded(true);
    }).catch(() => {
      // MR-G1 — the editor's writes send the WHOLE config (`persist(rules, …)`),
      // so an unread config plus an enabled Save silently replaces every stored
      // rule with the empty list this page happens to be holding. A failed read
      // must disable the writes, not just report itself.
      // ONE notice for one failure (MR66UX-8): the guard below says what failed
      // and what it means; the raw transport message is not shown.
      setLoadFailed(true);
      setLoaded(true);
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  const writable = canManage && !loadFailed && !busy;

  const persist = async (nextRules: RoutingRule[], nextFallback: RoutingTarget | null): Promise<void> => {
    if (!canManage || loadFailed) return;
    setBusy(true);
    try {
      const stored = await setRouterConfig({ rules: nextRules, ...(nextFallback ? { fallback: nextFallback } : {}) });
      setHasConfig(true); setEnabled(stored.enabled); setRules(stored.config.rules); setFallback(stored.config.fallback ?? null);
      setConfigVersion((v) => v + 1);
      // A first save creates the config switched OFF (MR66UX-5) — say so, or the
      // admin believes the rule is live.
      toast.success(stored.enabled
        ? t('saved', { defaultValue: 'Routing saved' })
        : t('savedOff', { defaultValue: 'Saved. Routing is off — turn it on to apply it.' }));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed', { defaultValue: 'Could not save routing.' })); }
    finally { setBusy(false); }
  };

  const toggleEnabled = async (next: boolean): Promise<void> => {
    setBusy(true);
    try { const stored = await setRouterEnabled(next); setEnabled(stored.enabled); setConfigVersion((v) => v + 1); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('toggleFailed', { defaultValue: 'Could not change routing state.' })); }
    finally { setBusy(false); }
  };

  const buildCondition = (): RuleCondition | null => {
    switch (kind) {
      case 'always': return { kind: 'always' };
      case 'attachment': return { kind: 'attachment' };
      case 'tokensOver': {
        const n = Number(threshold);
        if (!Number.isFinite(n) || n < 0) { toast.error(t('badThreshold', { defaultValue: 'Token threshold must be a non-negative number.' })); return null; }
        return { kind: 'tokensOver', threshold: Math.floor(n) };
      }
      case 'difficultyAtLeast': return { kind: 'difficultyAtLeast', level: difficulty };
      case 'conversationKind': return { kind: 'conversationKind', value: conversationKind };
    }
  };

  const addRule = (): void => {
    const when = buildCondition();
    if (!when) return;
    void persist([...rules, { when, target }], fallback);
  };

  // Inside the Models console the console owns the page chrome → no header here.
  const header = embedded ? null : (
    <PageHeader
      eyebrow={t('eyebrow', { defaultValue: 'Platform' })}
      title={t('title', { defaultValue: 'Model routing' })}
      lede={t('lede', { defaultValue: 'Choose a model for each chat message by rule: a cheaper model for simple messages, a stronger one when it matters.' })}
    />
  );

  if (!loaded) {
    return (
      <div className="u-flex u-flex-col u-gap-3" aria-busy="true">
        {header}
        <span className="sr-only">{t('loading', { defaultValue: 'Loading routing…' })}</span>
        <div className="surface-card u-pad-2 u-flex u-flex-col u-gap-2"><Skeleton width="40%" height={16} /><Skeleton width="100%" height={36} /></div>
        <div className="surface-card u-pad-2 u-flex u-flex-col u-gap-2"><Skeleton width="30%" height={16} /><Skeleton width="100%" height={36} /></div>
      </div>
    );
  }

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {header}
      {/* `announce` is REQUIRED, not decoration: `variant="warning"` renders
          role="status"/aria-live="polite", and a live region that ARRIVES
          complete announces nothing. Only the `error` variant is assertive. This
          disclosure was silent to screen readers until 2026-08-10 and the gate
          could not see it — see check-notice-announce.mjs FAILED_READ_GATE. */}
      {loadFailed && (
        <Notice variant="warning" announce={t('loadFailedGuard', { defaultValue: 'Editing is disabled because the current routing config could not be read — saving now would replace every stored rule with what is on screen.' })}>
          {t('loadFailedGuard', { defaultValue: 'Editing is disabled because the current routing config could not be read — saving now would replace every stored rule with what is on screen.' })}{' '}
          <Button variant="quiet" size="sm" onClick={load}>
            {t('retryLoad', { defaultValue: 'Try again' })}
          </Button>
        </Notice>
      )}

      <p className="muted u-fs-12 u-m-0">
        {t('scopeNote', { defaultValue: 'Routing applies to every chat in this workspace and is decided again for each message. A rule only applies to conversations that use a key for its provider. Conversations on the free tier or a subscription are never routed. If a routed model can’t answer, the message falls back to the conversation’s own model.' })}
      </p>
      {!loadFailed && !canManage && (
        <Notice variant="info">{t('readOnly', { defaultValue: 'Only people who manage this workspace’s API keys can change routing. You can still test a message below.' })}</Notice>
      )}

      <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
        <CheckboxField
          label={t('enableLabel', { defaultValue: 'Use routing in this workspace' })}
          checked={enabled}
          disabled={!writable || !hasConfig}
          onChange={(e) => void toggleEnabled(e.target.checked)}
          {...(loadFailed ? {} : {
            help: !hasConfig && canManage
              ? t('enableHint', { defaultValue: 'Save a rule first.' })
              : t('enableOffHelp', { defaultValue: 'Off: every message uses its conversation’s own model.' }),
          })}
        />
        {!hasConfig && !loadFailed && <span className="chip chip--muted u-fs-11">{t('notConfigured', { defaultValue: 'not configured' })}</span>}
      </div>

      <section aria-labelledby="mr-rules-h" className="u-flex u-flex-col u-gap-2">
        <h2 id="mr-rules-h" className="u-fs-13 u-m-0">{t('rulesHeading', { defaultValue: 'Rules, checked in order' })}</h2>
        <p className="muted u-fs-11 u-m-0">{t('rulesOrderHelp', { defaultValue: 'The first rule that matches the message and can run on the conversation’s provider is used.' })}</p>
        {/* MR-R2-1 — a failed read gets its own sentence, never "no rules": that
            would be a claim about live routing made from a read that never arrived. */}
        {loadFailed ? (
          <p className="muted u-fs-12 u-m-0">{t('rulesUnknown', { defaultValue: 'The current rules could not be read, so what routing is doing right now is unknown.' })}</p>
        ) : rules.length === 0 ? (
          <p className="muted u-fs-12 u-m-0">{t('noRules', { defaultValue: 'No rules yet. Until you add one, every message uses its conversation’s own model.' })}</p>
        ) : null}
        {/* role="list": Safari/VoiceOver drops list semantics under list-style:none (MR66UX-9). */}
        <ol role="list" className="u-list-none u-p-0 u-m-0 u-flex u-flex-col u-gap-2">
          {rules.map((r, i) => {
            const label = modelLabel(r.target);
            return (
              <li key={`${r.when.kind}-${i}`} className="surface-card u-pad-2 u-flex u-flex-row u-flex-wrap u-items-center u-justify-between u-gap-2">
                <div className="u-flex u-flex-wrap u-items-center u-gap-1 u-fs-12 u-min-w-0">
                  <span className="muted">{t('ruleNumber', { defaultValue: '{{n}}.', n: i + 1 })}</span>
                  <span>{t('whenPrefix', { defaultValue: 'When' })}</span>
                  <span className="chip chip--muted">{condLabel(r.when, t)}</span>
                  <span className="muted">{t('routesTo', { defaultValue: 'use' })}</span>
                  <span className="chip chip--accent">{label ?? `${r.target.provider}/${r.target.model}`}</span>
                  {label === null && <span className="chip chip--warning">{t('notInCatalog', { defaultValue: 'not in catalog' })}</span>}
                  {label === null && <span className="muted u-fs-11">{t('notInCatalogHelp', { defaultValue: 'This rule is never used. Remove it before saving other changes.' })}</span>}
                </div>
                {canManage && (
                  <Button variant="secondary" size="sm" disabled={!writable} onClick={() => void persist(rules.filter((_, j) => j !== i), fallback)} aria-label={t('removeAria', { defaultValue: 'Remove rule {{n}}', n: i + 1 })}>
                    {t('remove', { defaultValue: 'Remove' })}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <FallbackSection
        fallback={fallback}
        canManage={canManage}
        writable={writable}
        onSave={(next) => void persist(rules, next)}
      />

      {canManage && (
        <section aria-labelledby="mr-add-h" className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
          <h2 id="mr-add-h" className="u-fs-13 u-m-0">{t('addHeading', { defaultValue: 'Add a rule' })}</h2>
          <div className="u-flex u-flex-wrap u-items-end u-gap-2">
            <SelectField label={t('whenLabel', { defaultValue: 'When' })} className="u-w-auto u-mb-0" value={kind} onChange={(e) => setKind(e.target.value as CondKind)}>
              {COND_KINDS.map((k) => <option key={k} value={k}>{t(`kind_${k}`, { defaultValue: k })}</option>)}
            </SelectField>
            {kind === 'tokensOver' && (
              <TextField label={t('thresholdLabel', { defaultValue: 'Estimated tokens in the message' })} help={t('thresholdHelp', { defaultValue: 'About 4 characters per token. Earlier messages in the conversation don’t count.' })} className="u-w-auto u-mb-0" type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            )}
            {kind === 'difficultyAtLeast' && (
              <SelectField label={t('difficultyLabel', { defaultValue: 'Difficulty at least' })} help={t('difficultyHelp', { defaultValue: 'Estimated from length only: under about 500 tokens is low, under about 4,000 medium, longer is high. An attachment raises it one level.' })} className="u-w-auto u-mb-0" value={difficulty} onChange={(e) => setDifficulty(e.target.value as (typeof DIFFICULTY_LEVELS)[number])}>
                {DIFFICULTY_LEVELS.map((l) => <option key={l} value={l}>{t(`difficulty_${l}`, { defaultValue: l })}</option>)}
              </SelectField>
            )}
            {kind === 'conversationKind' && (
              <SelectField label={t('conversationKindLabel', { defaultValue: 'Conversation kind' })} className="u-w-auto u-mb-0" value={conversationKind} onChange={(e) => setConversationKind(e.target.value as (typeof CONVERSATION_KINDS)[number])} help={t('conversationKindHint', { defaultValue: '“group” = board / multi-agent rooms — route them to your strongest model.' })}>
                {CONVERSATION_KINDS.map((k) => <option key={k} value={k}>{t(`convKind_${k}`, { defaultValue: k })}</option>)}
              </SelectField>
            )}
          </div>
          <TargetPicker value={target} onChange={setTarget} legend={t('targetLegend', { defaultValue: 'Use this model' })} />
          {kind === 'attachment' && !acceptsImages(target) && (
            <p className="muted u-fs-11 u-m-0" role="note">{t('attachmentTextOnly', { defaultValue: 'This model can’t read images, so this rule would never be used for a message with an attachment.' })}</p>
          )}
          <div><Button variant="primary" size="sm" disabled={!writable} onClick={addRule}>{t('addRule', { defaultValue: 'Add rule' })}</Button></div>
        </section>
      )}

      <PreviewSection key={configVersion} enabled={enabled} hasConfig={hasConfig} canManage={canManage} />
    </div>
  );
}

/** ADR 1016 D5 — what happens to a message no rule matches. */
function FallbackSection({ fallback, canManage, writable, onSave }: {
  fallback: RoutingTarget | null;
  canManage: boolean;
  writable: boolean;
  onSave: (next: RoutingTarget | null) => void;
}): JSX.Element {
  const { t } = useTranslation('model-router');
  const listed = fallback !== null && modelLabel(fallback) !== null;
  const [useFallback, setUseFallback] = useState(fallback !== null);
  // A stored fallback the catalog no longer lists can't be shown in the picker
  // (MR66UX-7), so the draft starts from a catalog default and the note below says why.
  const [draft, setDraft] = useState<RoutingTarget>(listed && fallback ? fallback : defaultTarget());
  // Keyed on the VALUES, not the object: every rule save hands back a new
  // `fallback` object, and keying on it wiped unsaved edits here (MR66UX-6).
  const fbProvider = fallback?.provider;
  const fbModel = fallback?.model;
  useEffect(() => {
    const stored = fbProvider && fbModel ? { provider: fbProvider, model: fbModel } : null;
    setUseFallback(stored !== null);
    if (stored && modelLabel(stored) !== null) setDraft(stored);
  }, [fbProvider, fbModel]);
  const dirty = useFallback !== (fallback !== null)
    || (useFallback && (draft.provider !== fbProvider || draft.model !== fbModel));
  const current = fallback ? (modelLabel(fallback) ?? `${fallback.provider}/${fallback.model}`) : null;
  return (
    <section aria-labelledby="mr-fallback-h" className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
      <h2 id="mr-fallback-h" className="u-fs-13 u-m-0">{t('fallbackHeading', { defaultValue: 'When no rule matches' })}</h2>
      {fallback && !listed && (
        <p className="muted u-fs-11 u-m-0">
          <span className="chip chip--warning">{t('notInCatalog', { defaultValue: 'not in catalog' })}</span>{' '}
          {t('fallbackNotInCatalog', { defaultValue: 'The saved fallback ({{model}}) is never used. Choose another or turn it off.', model: current })}
        </p>
      )}
      {!canManage ? (
        <p className="u-fs-12 u-m-0">
          {current
            ? t('fallbackUses', { defaultValue: 'Use {{model}}.', model: current })
            : t('fallbackKeep', { defaultValue: 'Keep the conversation’s own model.' })}
        </p>
      ) : (
        <>
          <CheckboxField
            label={t('fallbackToggle', { defaultValue: 'Send these messages to a fallback model instead of the conversation’s own' })}
            help={t('fallbackHint', { defaultValue: 'Off is usually right: members keep the model they chose. The fallback only applies to conversations whose key belongs to its provider, and to a message with an attachment only if its model reads images.' })}
            checked={useFallback}
            disabled={!writable}
            onChange={(e) => setUseFallback(e.target.checked)}
          />
          {useFallback && <TargetPicker value={draft} onChange={setDraft} legend={t('fallbackLegend', { defaultValue: 'Fallback model' })} />}
          <div className="u-flex u-items-center u-gap-2">
            <Button variant="secondary" size="sm" disabled={!writable || !dirty} onClick={() => onSave(useFallback ? draft : null)}>
              {t('saveFallback', { defaultValue: 'Save' })}
            </Button>
            {dirty && <span className="chip chip--muted u-fs-11">{t('unsaved', { defaultValue: 'unsaved' })}</span>}
          </div>
        </>
      )}
    </section>
  );
}

/** A provider + model choice from the catalog — never free text (ADR 1016 D5).
 *  A model that cannot read images is marked, since an attachment message never
 *  routes to it (MR66UX-3). */
function TargetPicker({ value, onChange, legend }: { value: RoutingTarget; onChange: (t: RoutingTarget) => void; legend: string }): JSX.Element {
  const { t } = useTranslation('model-router');
  const provider = ROUTABLE.find((p) => p.id === value.provider) ?? ROUTABLE[0];
  return (
    <fieldset className="u-border-0 u-p-0 u-m-0 u-flex u-flex-wrap u-items-end u-gap-2">
      <legend className="u-fs-12 u-fw-600 u-mb-1">{legend}</legend>
      <SelectField
        label={t('provider', { defaultValue: 'Provider' })}
        className="u-w-auto u-mb-0"
        value={provider?.id ?? ''}
        onChange={(e) => {
          const next = ROUTABLE.find((p) => p.id === e.target.value);
          const m = next?.models.find((x) => x.recommended) ?? next?.models[0];
          onChange({ provider: next?.id ?? '', model: m?.id ?? '' });
        }}
      >
        {ROUTABLE.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </SelectField>
      <SelectField label={t('model', { defaultValue: 'Model' })} className="u-w-auto u-mb-0" value={value.model} onChange={(e) => onChange({ provider: provider?.id ?? '', model: e.target.value })}>
        {(provider?.models ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.capabilities.includes('vision') ? m.label : t('textOnlyModel', { defaultValue: '{{label}} (text only)', label: m.label })}
          </option>
        ))}
      </SelectField>
    </fieldset>
  );
}

type PreviewInput = { text: string; provider: string; hasAttachment: boolean; kind: '' | (typeof CONVERSATION_KINDS)[number] };

/** ADR 1016 D6 — "which model would this message get?", answered by the server.
 *  The answer is stored WITH the request it answers and cleared when any input
 *  changes (MR66UX-1); the parent re-keys this section on every saved change, so
 *  an answer about the old rules never stays on screen either. */
function PreviewSection({ enabled, hasConfig, canManage }: { enabled: boolean; hasConfig: boolean; canManage: boolean }): JSX.Element {
  const { t } = useTranslation('model-router');
  const resultId = useId();
  const [input, setInput] = useState<PreviewInput>({ text: '', provider: ROUTABLE[0]?.id ?? '', hasAttachment: false, kind: '' });
  const [answered, setAnswered] = useState<{ input: PreviewInput; result: RoutePreview } | null>(null);
  const [testing, setTesting] = useState(false);
  const change = (patch: Partial<PreviewInput>): void => { setInput((cur) => ({ ...cur, ...patch })); setAnswered(null); };

  const run = async (): Promise<void> => {
    const asked = input;
    setAnswered(null); // the live region changes even when the answer repeats
    setTesting(true);
    try {
      const result = await previewRoute({ text: asked.text, provider: asked.provider, hasAttachment: asked.hasAttachment, ...(asked.kind ? { conversationKind: asked.kind } : {}) });
      setAnswered({ input: asked, result });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('previewFailed', { defaultValue: 'Could not test the message.' }));
    } finally { setTesting(false); }
  };

  let answer: string | null = null;
  if (answered) {
    const d = answered.result.decision;
    const providerLabel = ROUTABLE.find((p) => p.id === answered.input.provider)?.label ?? answered.input.provider;
    if (!d) answer = t('previewKeeps', { defaultValue: 'No rule that can run on a {{provider}} key matches, so it keeps the conversation’s own model.', provider: providerLabel });
    else {
      const model = modelLabel(d.target) ?? `${d.target.provider}/${d.target.model}`;
      answer = d.reason === 'rule' && d.ruleIndex !== undefined
        ? t('previewRule', { defaultValue: 'Rule {{n}} sends it to {{model}}.', n: d.ruleIndex + 1, model })
        : t('previewFallback', { defaultValue: 'No rule matches, so the fallback sends it to {{model}}.', model });
    }
  }

  return (
    <section aria-labelledby="mr-preview-h" className="surface-card u-pad-2 u-flex u-flex-col u-gap-2">
      <h2 id="mr-preview-h" className="u-fs-13 u-m-0">{t('previewHeading', { defaultValue: 'Test a message' })}</h2>
      <TextareaField label={t('previewText', { defaultValue: 'Message' })} rows={3} value={input.text} onChange={(e) => change({ text: e.target.value })} />
      <div className="u-flex u-flex-wrap u-items-end u-gap-2">
        <SelectField label={t('previewProvider', { defaultValue: 'The conversation’s key is for' })} className="u-w-auto u-mb-0" value={input.provider} onChange={(e) => change({ provider: e.target.value })}>
          {ROUTABLE.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </SelectField>
        <SelectField label={t('conversationKindLabel', { defaultValue: 'Conversation kind' })} className="u-w-auto u-mb-0" value={input.kind} onChange={(e) => change({ kind: e.target.value as PreviewInput['kind'] })}>
          <option value="">{t('convKind_direct', { defaultValue: 'one-to-one' })}</option>
          {CONVERSATION_KINDS.map((k) => <option key={k} value={k}>{t(`convKind_${k}`, { defaultValue: k })}</option>)}
        </SelectField>
        <CheckboxField label={t('previewAttachment', { defaultValue: 'Has an attachment' })} checked={input.hasAttachment} onChange={(e) => change({ hasAttachment: e.target.checked })} />
        <Button
          variant="secondary"
          size="sm"
          disabled={testing || !hasConfig}
          aria-busy={testing || undefined}
          onClick={() => void run()}
          {...(!hasConfig ? { 'aria-describedby': resultId } : {})}
        >
          {testing ? t('previewRunning', { defaultValue: 'Testing…' }) : t('previewRun', { defaultValue: 'Test' })}
        </Button>
      </div>
      <p id={resultId} className="u-fs-12 u-m-0" role="status" aria-live="polite">
        {!hasConfig
          ? <span className="muted">{canManage
            ? t('previewNeedsConfig', { defaultValue: 'Add a rule to test messages against it.' })
            : t('previewNoRouting', { defaultValue: 'No routing is set up for this workspace.' })}</span>
          : answer && (
            <>
              {answer}
              {!enabled && <span className="muted"> {t('previewOff', { defaultValue: 'Routing is off, so today it keeps its own model.' })}</span>}
            </>
          )}
      </p>
    </section>
  );
}
